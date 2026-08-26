import { decryptJson } from "./crypto";
import { getBlog } from "./db";
import { platformAdapter } from "./platforms";
import { reconcilePublicationContentUpdate } from "./publication-store";
import {
  markContentRevisionApplied,
  markContentRevisionFailed,
  publicationForRevision,
  revisionMatchesSnapshot,
  stalePreparedRevisions,
} from "./content-revisions";

export interface ContentRevisionUncertainty {
  revisionId: number;
  scope: string;
  detail: string;
}

export interface ContentRevisionReconcileResult {
  evaluated: number;
  recoveredApplied: number;
  recoveredNoMutation: number;
  uncertain: ContentRevisionUncertainty[];
}

function detail(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export async function reconcileStalePreparedContentRevisions(
  staleMinutes = 15,
): Promise<ContentRevisionReconcileResult> {
  const stale = stalePreparedRevisions(staleMinutes, 100);
  let recoveredApplied = 0;
  let recoveredNoMutation = 0;
  const uncertain: ContentRevisionUncertainty[] = [];

  for (const revision of stale) {
    const scope = `revision:${revision.id}`;
    try {
      const blog = getBlog(revision.blogId);
      if (!blog) {
        uncertain.push({ revisionId: revision.id, scope, detail: `ブログ ${revision.blogName} が見つからずrevisionを照合できません` });
        continue;
      }
      const publication = publicationForRevision(revision);
      const credentials = decryptJson<unknown>(blog.credentialsCipher);
      const adapter = platformAdapter(blog.platform);

      // F-052 is deliberately read-only against the external CMS. It resolves
      // process-crash ambiguity only from the current remote state; it never
      // retries the mutation and never performs rollback automatically.
      const current = await adapter.readPost(blog, credentials, publication);
      const matchesBefore = revisionMatchesSnapshot(revision, current, "before");
      const matchesAfter = revisionMatchesSnapshot(revision, current, "after");

      if (matchesAfter && !matchesBefore) {
        markContentRevisionApplied(revision.id, { updatedAt: current.updatedAt });
        reconcilePublicationContentUpdate(publication.id, {
          title: revision.axes.includes("headline") ? revision.after.title : undefined,
        });
        recoveredApplied += 1;
        continue;
      }

      if (matchesBefore) {
        markContentRevisionFailed(
          revision.id,
          matchesAfter
            ? "stale prepared revision reconciled: before/after are observationally identical; no remote mutation is asserted"
            : "stale prepared revision reconciled: remote content still matches the pre-mutation snapshot",
        );
        recoveredNoMutation += 1;
        continue;
      }

      uncertain.push({
        revisionId: revision.id,
        scope,
        detail: `${revision.blogName} / ${revision.mutationKind} の現在CMS内容が変更前・予定変更後のどちらにも一致しません。人間編集または別プロセス変更の可能性があるため自動操作を停止しています`,
      });
    } catch (error) {
      uncertain.push({
        revisionId: revision.id,
        scope,
        detail: `${revision.blogName} / ${revision.mutationKind} のstale revision照合に失敗: ${detail(error)}`,
      });
    }
  }

  return {
    evaluated: stale.length,
    recoveredApplied,
    recoveredNoMutation,
    uncertain,
  };
}
