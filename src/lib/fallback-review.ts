import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type DB = InstanceType<typeof Database>;

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
  reviewed_at TEXT NOT NULL
);
`);

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

export function markFallbackReviewReviewed(publicationId: number): void {
  if (!Number.isInteger(publicationId) || publicationId <= 0) throw new Error("publicationId must be a positive integer");
  db.prepare(`INSERT INTO fallback_review_state (publication_id,reviewed_at) VALUES (?,?)
    ON CONFLICT(publication_id) DO UPDATE SET reviewed_at=excluded.reviewed_at`)
    .run(publicationId, new Date().toISOString());
}
