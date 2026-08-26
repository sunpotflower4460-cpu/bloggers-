import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type DB = InstanceType<typeof Database>;
export type FallbackReviewOutcome = "quality-ok" | "needs-improvement";

export interface FallbackReviewItem {
  publicationId: number;
  blogId: string;
  blogName: string;
  platform: string;
  title: string;
  url: string;
  status: string;
  providerLabel: string;
  model: string;
  bypassedPrimary: boolean;
  createdAt: string;
}

export interface FallbackPublishItem extends FallbackReviewItem {
  reviewedAt: string;
}

export interface FallbackQualitySummary {
  providerLabel: string;
  model: string;
  reviewed: number;
  qualityOk: number;
  needsImprovement: number;
  approvalRate: number | null;
  signal: "insufficient-sample" | "strong" | "mixed" | "weak";
}

export type FallbackPublishEligibilityReason =
  | "eligible"
  | "not-found"
  | "not-draft"
  | "not-reviewed"
  | "not-quality-ok"
  | "not-forced-fallback";

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenFallbackReviewDb?: DB };
const db = globalDb.__blogGardenFallbackReviewDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenFallbackReviewDb = db;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS fallback_review_state (
  publication_id INTEGER PRIMARY KEY,
  reviewed_at TEXT NOT NULL,
  outcome TEXT
);
`);
const reviewColumns = new Set(
  (db.prepare("PRAGMA table_info(fallback_review_state)").all() as Array<{ name: string }>).map((row) => row.name),
);
if (!reviewColumns.has("outcome")) db.exec("ALTER TABLE fallback_review_state ADD COLUMN outcome TEXT");

function positivePublicationId(publicationId: number): number {
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    throw new Error("publicationId must be a positive integer");
  }
  return publicationId;
}

export function fallbackReviewQueue(limit = 20): FallbackReviewItem[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT
      p.id publication_id,
      p.blog_id,
      b.name blog_name,
      b.platform,
      p.title,
      p.url,
      p.status,
      COALESCE(json_extract(r.meta_json, '$.aiRoute.label'), 'fallback') provider_label,
      COALESCE(json_extract(r.meta_json, '$.aiRoute.model'), 'unknown') model,
      COALESCE(json_extract(r.meta_json, '$.aiRoute.bypassedPrimary'), 0) bypassed_primary,
      p.created_at
    FROM run_logs r
    JOIN publications p
      ON p.blog_id = r.blog_id
     AND p.platform_post_id = CAST(json_extract(r.meta_json, '$.result.platformPostId') AS TEXT)
    JOIN blogs b ON b.id = p.blog_id
    LEFT JOIN fallback_review_state reviewed ON reviewed.publication_id = p.id
    WHERE r.kind = 'editorial'
      AND r.status = 'ok'
      AND COALESCE(json_extract(r.meta_json, '$.fallbackForcedReview'), 0) = 1
      AND reviewed.reviewed_at IS NULL
    ORDER BY r.finished_at DESC
    LIMIT ?
  `).all(safeLimit) as Array<{
    publication_id: number;
    blog_id: string;
    blog_name: string;
    platform: string;
    title: string;
    url: string;
    status: string;
    provider_label: string;
    model: string;
    bypassed_primary: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    publicationId: Number(row.publication_id),
    blogId: row.blog_id,
    blogName: row.blog_name,
    platform: row.platform,
    title: row.title,
    url: row.url,
    status: row.status,
    providerLabel: row.provider_label,
    model: row.model,
    bypassedPrimary: Boolean(row.bypassed_primary),
    createdAt: row.created_at,
  }));
}

export function fallbackApprovedPublishQueue(limit = 20): FallbackPublishItem[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT
      p.id publication_id,
      p.blog_id,
      b.name blog_name,
      b.platform,
      p.title,
      p.url,
      p.status,
      s.reviewed_at,
      COALESCE((SELECT json_extract(r.meta_json, '$.aiRoute.label')
        FROM run_logs r
        WHERE r.blog_id=p.blog_id
          AND r.kind='editorial'
          AND r.status='ok'
          AND COALESCE(json_extract(r.meta_json, '$.fallbackForcedReview'), 0)=1
          AND CAST(json_extract(r.meta_json, '$.result.platformPostId') AS TEXT)=p.platform_post_id
        ORDER BY r.finished_at DESC LIMIT 1), 'fallback') provider_label,
      COALESCE((SELECT json_extract(r.meta_json, '$.aiRoute.model')
        FROM run_logs r
        WHERE r.blog_id=p.blog_id
          AND r.kind='editorial'
          AND r.status='ok'
          AND COALESCE(json_extract(r.meta_json, '$.fallbackForcedReview'), 0)=1
          AND CAST(json_extract(r.meta_json, '$.result.platformPostId') AS TEXT)=p.platform_post_id
        ORDER BY r.finished_at DESC LIMIT 1), 'unknown') model,
      COALESCE((SELECT json_extract(r.meta_json, '$.aiRoute.bypassedPrimary')
        FROM run_logs r
        WHERE r.blog_id=p.blog_id
          AND r.kind='editorial'
          AND r.status='ok'
          AND COALESCE(json_extract(r.meta_json, '$.fallbackForcedReview'), 0)=1
          AND CAST(json_extract(r.meta_json, '$.result.platformPostId') AS TEXT)=p.platform_post_id
        ORDER BY r.finished_at DESC LIMIT 1), 0) bypassed_primary,
      p.created_at
    FROM fallback_review_state s
    JOIN publications p ON p.id=s.publication_id
    JOIN blogs b ON b.id=p.blog_id
    WHERE s.outcome='quality-ok'
      AND p.status='draft'
      AND EXISTS (
        SELECT 1 FROM run_logs r
        WHERE r.blog_id=p.blog_id
          AND r.kind='editorial'
          AND r.status='ok'
          AND COALESCE(json_extract(r.meta_json, '$.fallbackForcedReview'), 0)=1
          AND CAST(json_extract(r.meta_json, '$.result.platformPostId') AS TEXT)=p.platform_post_id
      )
    ORDER BY s.reviewed_at ASC
    LIMIT ?
  `).all(safeLimit) as Array<{
    publication_id: number;
    blog_id: string;
    blog_name: string;
    platform: string;
    title: string;
    url: string;
    status: string;
    reviewed_at: string;
    provider_label: string;
    model: string;
    bypassed_primary: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    publicationId: Number(row.publication_id),
    blogId: row.blog_id,
    blogName: row.blog_name,
    platform: row.platform,
    title: row.title,
    url: row.url,
    status: row.status,
    providerLabel: row.provider_label,
    model: row.model,
    bypassedPrimary: Boolean(row.bypassed_primary),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }));
}

export function fallbackPublishEligibility(publicationId: number): {
  eligible: boolean;
  reason: FallbackPublishEligibilityReason;
} {
  const id = positivePublicationId(publicationId);
  const row = db.prepare(`
    SELECT
      p.status,
      s.reviewed_at,
      s.outcome,
      EXISTS (
        SELECT 1 FROM run_logs r
        WHERE r.blog_id=p.blog_id
          AND r.kind='editorial'
          AND r.status='ok'
          AND COALESCE(json_extract(r.meta_json, '$.fallbackForcedReview'), 0)=1
          AND CAST(json_extract(r.meta_json, '$.result.platformPostId') AS TEXT)=p.platform_post_id
      ) forced_fallback
    FROM publications p
    LEFT JOIN fallback_review_state s ON s.publication_id=p.id
    WHERE p.id=?
  `).get(id) as {
    status: string;
    reviewed_at: string | null;
    outcome: string | null;
    forced_fallback: number;
  } | undefined;

  if (!row) return { eligible: false, reason: "not-found" };
  if (row.status !== "draft") return { eligible: false, reason: "not-draft" };
  if (!row.reviewed_at) return { eligible: false, reason: "not-reviewed" };
  if (row.outcome !== "quality-ok") return { eligible: false, reason: "not-quality-ok" };
  if (!row.forced_fallback) return { eligible: false, reason: "not-forced-fallback" };
  return { eligible: true, reason: "eligible" };
}

export function recordFallbackReviewOutcome(publicationId: number, outcome: FallbackReviewOutcome): void {
  const id = positivePublicationId(publicationId);
  if (outcome !== "quality-ok" && outcome !== "needs-improvement") {
    throw new Error("fallback review outcome must be quality-ok or needs-improvement");
  }
  db.prepare(`INSERT INTO fallback_review_state (publication_id,reviewed_at,outcome) VALUES (?,?,?)
    ON CONFLICT(publication_id) DO UPDATE SET reviewed_at=excluded.reviewed_at,outcome=excluded.outcome`)
    .run(id, new Date().toISOString(), outcome);
}

// Backward-compatible acknowledgment for any older callers. It intentionally does
// not count toward provider/model quality statistics because no quality judgment
// was captured.
export function markFallbackReviewReviewed(publicationId: number): void {
  const id = positivePublicationId(publicationId);
  db.prepare(`INSERT INTO fallback_review_state (publication_id,reviewed_at,outcome) VALUES (?,?,NULL)
    ON CONFLICT(publication_id) DO UPDATE SET reviewed_at=excluded.reviewed_at`)
    .run(id, new Date().toISOString());
}

export function fallbackQualitySummaries(): FallbackQualitySummary[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(json_extract(r.meta_json, '$.aiRoute.label'), 'fallback') provider_label,
      COALESCE(json_extract(r.meta_json, '$.aiRoute.model'), 'unknown') model,
      COUNT(*) reviewed,
      SUM(CASE WHEN s.outcome='quality-ok' THEN 1 ELSE 0 END) quality_ok,
      SUM(CASE WHEN s.outcome='needs-improvement' THEN 1 ELSE 0 END) needs_improvement
    FROM fallback_review_state s
    JOIN publications p ON p.id=s.publication_id
    JOIN run_logs r
      ON r.blog_id=p.blog_id
     AND r.kind='editorial'
     AND r.status='ok'
     AND COALESCE(json_extract(r.meta_json, '$.fallbackForcedReview'), 0)=1
     AND CAST(json_extract(r.meta_json, '$.result.platformPostId') AS TEXT)=p.platform_post_id
    WHERE s.outcome IN ('quality-ok','needs-improvement')
    GROUP BY provider_label, model
    ORDER BY reviewed DESC, provider_label ASC, model ASC
  `).all() as Array<{
    provider_label: string;
    model: string;
    reviewed: number;
    quality_ok: number;
    needs_improvement: number;
  }>;

  return rows.map((row) => {
    const reviewed = Number(row.reviewed || 0);
    const qualityOk = Number(row.quality_ok || 0);
    const needsImprovement = Number(row.needs_improvement || 0);
    const approvalRate = reviewed > 0 ? qualityOk / reviewed : null;
    let signal: FallbackQualitySummary["signal"] = "insufficient-sample";
    if (reviewed >= 10 && approvalRate !== null) {
      signal = approvalRate >= 0.9 ? "strong" : approvalRate >= 0.7 ? "mixed" : "weak";
    }
    return {
      providerLabel: row.provider_label,
      model: row.model,
      reviewed,
      qualityOk,
      needsImprovement,
      approvalRate,
      signal,
    };
  });
}
