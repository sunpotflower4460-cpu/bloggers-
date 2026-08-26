import { decryptJson } from "./crypto";
import { getBlog, recordRun } from "./db";
import { acquireBlogLease, releaseBlogLease } from "./leases";
import { platformAdapter } from "./platforms";
import { reconcilePublicationContentUpdate } from "./publication-store";
import { markContentRefreshRolledBack } from "./refresh-store";
import {
  assertRevisionStillMatchesAppliedState,
  getContentRevision,
  markContentRevisionRolledBack,
  publicationForRevision,
  revisionRollbackUpdate,
} from "./content-revisions";

export type ContentRollbackErrorCode = "not-found" | "not-eligible" | "busy" | "conflict";

export class ContentRollbackError extends Error {
  constructor(public readonly code: ContentRollbackErrorCode, message: string) {
    super(message);
    this.name = "ContentRollbackError";
  }
}

export async function rollbackContentRevision(revisionId: number): Promise<{
  revisionId: number;
  blogId: string;
  title: string;
  url: string;
}> {
  const revision = getContentRevision(revisionId);
  if (!revision) throw new ContentRollbackError("not-found", "revision snapshot was not found");
  if (revision.status !== "applied") {
    throw new ContentRollbackError("not-eligible", `revision is not rollback-eligible (status=${revision.status})`);
  }

  const blog = getBlog(revision.blogId);
  if (!blog) throw new ContentRollbackError("not-found", "blog for revision was not found");
  const lease = acquireBlogLease(blog.id);
  if (!lease) throw new ContentRollbackError("busy", "another operation is currently using this blog");

  const started = new Date().toISOString();
  try {
    const publication = publicationForRevision(revision);
    if (publication.status !== "published") {
      throw new ContentRollbackError("not-eligible", `publication is not currently published (status=${publication.status})`);
    }
    const credentials = decryptJson<unknown>(blog.credentialsCipher);
    const adapter = platformAdapter(blog.platform);
    const current = await adapter.readPost(blog, credentials, publication);

    try {
      assertRevisionStillMatchesAppliedState(revision, current);
    } catch (error) {
      throw new ContentRollbackError("conflict", error instanceof Error ? error.message : String(error));
    }

    // Only fields that the recorded autonomous mutation changed are restored.
    // For the current headline-only refresh this means title only, so later human
    // body edits are never overwritten by a rollback.
    const update = revisionRollbackUpdate(revision);
    const result = await adapter.updatePost(blog, credentials, publication, update, current);

    // The remote mutation is already complete at this point, so persist that fact
    // before secondary local bookkeeping. A later DB bookkeeping failure must not
    // leave the revision falsely advertised as still applied on the external CMS.
    markContentRevisionRolledBack(revision.id, result.updatedAt);
    markContentRefreshRolledBack(revision.id);
    const reconciled = reconcilePublicationContentUpdate(publication.id, {
      title: update.title,
      url: result.url,
    });

    recordRun(blog.id, "content-rollback", "ok", `Rolled back ${revision.mutationKind}: ${revision.after.title} → ${revision.before.title}`, {
      revisionId: revision.id,
      publicationId: publication.id,
      axes: revision.axes,
      result,
    }, started);

    return {
      revisionId: revision.id,
      blogId: blog.id,
      title: reconciled.title,
      url: reconciled.url,
    };
  } catch (error) {
    recordRun(blog.id, "content-rollback", "error", error instanceof Error ? error.message : String(error), {
      revisionId: revision.id,
    }, started);
    throw error;
  } finally {
    releaseBlogLease(lease);
  }
}
