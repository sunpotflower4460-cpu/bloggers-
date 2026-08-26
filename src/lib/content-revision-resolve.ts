import { decryptJson } from "./crypto";
import { getBlog, recordRun } from "./db";
import { acquireBlogLease, releaseBlogLease } from "./leases";
import { platformAdapter } from "./platforms";
import { reconcilePublicationContentUpdate } from "./publication-store";
import {
  getContentRevision,
  markContentRevisionResolvedExternal,
  publicationForRevision,
  revisionMatchesSnapshot,
} from "./content-revisions";

export type ContentRevisionResolveErrorCode = "not-found" | "not-eligible" | "busy";

export class ContentRevisionResolveError extends Error {
  constructor(public readonly code: ContentRevisionResolveErrorCode, message: string) {
    super(message);
    this.name = "ContentRevisionResolveError";
  }
}

function isStale(createdAt: string, minutes = 15): boolean {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) && Date.now() - created >= minutes * 60000;
}

export async function resolveContentRevisionAcceptCurrent(
  revisionId: number,
  reason: string,
): Promise<{
  revisionId: number;
  blogId: string;
  title: string;
  status: "resolved-external";
}> {
  const revision = getContentRevision(revisionId);
  if (!revision) throw new ContentRevisionResolveError("not-found", "revision snapshot was not found");
  if (revision.status !== "prepared" || !isStale(revision.createdAt, 15)) {
    throw new ContentRevisionResolveError("not-eligible", "only a prepared revision that has remained uncertain for at least 15 minutes can be resolved this way");
  }
  const cleanReason = String(reason || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (cleanReason.length < 4) {
    throw new ContentRevisionResolveError("not-eligible", "a short human resolution reason is required");
  }

  const blog = getBlog(revision.blogId);
  if (!blog) throw new ContentRevisionResolveError("not-found", "blog for revision was not found");
  const lease = acquireBlogLease(blog.id);
  if (!lease) throw new ContentRevisionResolveError("busy", "another operation is currently using this blog");

  const started = new Date().toISOString();
  try {
    const publication = publicationForRevision(revision);
    const credentials = decryptJson<unknown>(blog.credentialsCipher);
    const adapter = platformAdapter(blog.platform);

    // F-053 is local-only. The operator is accepting what already exists in the
    // CMS, so the external side is read exactly once and never mutated.
    const current = await adapter.readPost(blog, credentials, publication);
    const matchesBefore = revisionMatchesSnapshot(revision, current, "before");
    const matchesAfter = revisionMatchesSnapshot(revision, current, "after");
    if (matchesBefore || matchesAfter) {
      throw new ContentRevisionResolveError(
        "not-eligible",
        "the current CMS state is now safely identifiable as BEFORE or AFTER; let the normal F-052 reconciliation finalize it instead of using human third-state resolution",
      );
    }

    const resolved = markContentRevisionResolvedExternal(revision.id, current, cleanReason);
    const reconciled = reconcilePublicationContentUpdate(publication.id, {
      title: revision.axes.includes("headline") ? current.title : undefined,
    });
    recordRun(blog.id, "content-revision-resolution", "ok", `Accepted current CMS state for uncertain revision #${revision.id}`, {
      revisionId: revision.id,
      axes: revision.axes,
      reason: cleanReason,
      operatorResolvedAt: resolved.operatorResolvedAt,
      // Keep body/excerpt out of the run log. The full accepted snapshot is already
      // stored in content_revisions and may contain reader content not needed here.
      currentTitle: current.title,
      currentUpdatedAt: current.updatedAt,
    }, started);

    return {
      revisionId: revision.id,
      blogId: blog.id,
      title: reconciled.title,
      status: "resolved-external",
    };
  } catch (error) {
    recordRun(blog.id, "content-revision-resolution", "error", error instanceof Error ? error.message : String(error), {
      revisionId: revision.id,
    }, started);
    throw error;
  } finally {
    releaseBlogLease(lease);
  }
}
