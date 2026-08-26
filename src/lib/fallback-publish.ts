import { decryptJson } from "./crypto";
import { getBlog, recordRun } from "./db";
import { fallbackPublishEligibility } from "./fallback-review";
import { acquireBlogLease, releaseBlogLease } from "./leases";
import { platformAdapter } from "./platforms";
import type { BlogPlatformAdapter } from "./platforms/base";
import { getPublicationById, reconcilePublicationPublished } from "./publication-store";
import type { BlogPlatform } from "./types";

export type FallbackDraftPublishErrorCode =
  | "invalid-publication"
  | "not-eligible"
  | "blog-not-found"
  | "busy";

export class FallbackDraftPublishError extends Error {
  constructor(
    readonly code: FallbackDraftPublishErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FallbackDraftPublishError";
  }
}

type AdapterResolver = (platform: BlogPlatform) => BlogPlatformAdapter;

export async function publishApprovedFallbackDraft(
  publicationId: number,
  adapterResolver: AdapterResolver = platformAdapter,
): Promise<{
  publicationId: number;
  blogId: string;
  title: string;
  url: string;
  status: "published";
  publishedAt: string | null;
}> {
  const started = new Date().toISOString();
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    throw new FallbackDraftPublishError("invalid-publication", "publicationId must be a positive integer");
  }

  const initialPublication = getPublicationById(publicationId);
  if (!initialPublication) {
    throw new FallbackDraftPublishError("invalid-publication", "publication was not found");
  }
  const blog = getBlog(initialPublication.blogId);
  if (!blog) throw new FallbackDraftPublishError("blog-not-found", "blog was not found");

  const initialEligibility = fallbackPublishEligibility(publicationId);
  if (!initialEligibility.eligible) {
    throw new FallbackDraftPublishError("not-eligible", `fallback draft is not eligible for publish (${initialEligibility.reason})`);
  }

  const lease = acquireBlogLease(blog.id, 15);
  if (!lease) throw new FallbackDraftPublishError("busy", "another operation currently holds this blog lease");

  try {
    // Re-read after acquiring the lease so a concurrent review/status change cannot
    // pass a stale eligibility check from before the lock was obtained.
    const publication = getPublicationById(publicationId);
    const eligibility = fallbackPublishEligibility(publicationId);
    if (!publication || publication.blogId !== blog.id || !eligibility.eligible) {
      throw new FallbackDraftPublishError("not-eligible", `fallback draft is no longer eligible for publish (${eligibility.reason})`);
    }

    const credentials = decryptJson<unknown>(blog.credentialsCipher);
    const adapter = adapterResolver(blog.platform);
    const result = await adapter.publishDraft(blog, credentials, publication);
    if (result.status !== "published") throw new Error("platform adapter did not confirm published state");

    const reconciled = reconcilePublicationPublished(publicationId, result);
    recordRun(blog.id, "fallback-draft-publish", "ok", `Human-approved fallback draft published: ${reconciled.title}`, {
      publicationId,
      platform: blog.platform,
      platformPostId: reconciled.platformPostId,
      explicitHumanAction: true,
      result: {
        status: reconciled.status,
        url: reconciled.url,
        publishedAt: reconciled.publishedAt,
      },
    }, started);

    return {
      publicationId: reconciled.id,
      blogId: reconciled.blogId,
      title: reconciled.title,
      url: reconciled.url,
      status: "published",
      publishedAt: reconciled.publishedAt,
    };
  } catch (error) {
    recordRun(blog.id, "fallback-draft-publish", "error", error instanceof Error ? error.message : String(error), {
      publicationId,
      explicitHumanAction: true,
    }, started);
    throw error;
  } finally {
    releaseBlogLease(lease);
  }
}
