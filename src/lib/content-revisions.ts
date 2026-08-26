import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExistingPost, PostUpdate } from "./platforms/base";
import type { Publication } from "./types";

type DB = InstanceType<typeof Database>;
export type ContentRevisionStatus = "prepared" | "applied" | "failed" | "rolled-back";
export type ContentRevisionAxis = "headline" | "html" | "excerpt";

export interface RevisionSnapshot {
  title: string;
  html: string;
  excerpt: string;
  updatedAt: string | null;
}

export interface ContentRevision {
  id: number;
  publicationId: number;
  blogId: string;
  blogName: string;
  platform: string;
  platformPostId: string;
  publicationUrl: string;
  mutationKind: string;
  axes: ContentRevisionAxis[];
  before: RevisionSnapshot;
  after: RevisionSnapshot;
  status: ContentRevisionStatus;
  appliedUpdatedAt: string | null;
  rolledBackUpdatedAt: string | null;
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
}

export interface ContentRevisionOperationalSummary {
  stalePrepared: number;
  failedRecent: number;
  oldestStalePreparedAt: string | null;
}

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenContentRevisionDb?: DB };
const db = globalDb.__blogGardenContentRevisionDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenContentRevisionDb = db;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS content_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  mutation_kind TEXT NOT NULL,
  axes_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  status TEXT NOT NULL,
  applied_updated_at TEXT,
  rolled_back_updated_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  rolled_back_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_content_revisions_publication_created
  ON content_revisions(publication_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_revisions_status_created
  ON content_revisions(status, created_at DESC);
`);
const revisionColumns = new Set((db.prepare("PRAGMA table_info(content_revisions)").all() as Array<{ name: string }>).map((row) => row.name));
if (!revisionColumns.has("rolled_back_updated_at")) db.exec("ALTER TABLE content_revisions ADD COLUMN rolled_back_updated_at TEXT");

function cleanSnapshot(value: ExistingPost): RevisionSnapshot {
  return {
    title: String(value.title || ""),
    html: String(value.html || ""),
    excerpt: String(value.excerpt || ""),
    updatedAt: value.updatedAt || null,
  };
}

function intendedAfter(before: RevisionSnapshot, update: PostUpdate): RevisionSnapshot {
  return {
    title: update.title === undefined ? before.title : String(update.title),
    html: update.html === undefined ? before.html : String(update.html),
    excerpt: update.excerpt === undefined ? before.excerpt : String(update.excerpt),
    updatedAt: before.updatedAt,
  };
}

function safeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function parseSnapshot(raw: string): RevisionSnapshot {
  const value = JSON.parse(raw) as Partial<RevisionSnapshot>;
  return {
    title: String(value.title || ""),
    html: String(value.html || ""),
    excerpt: String(value.excerpt || ""),
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
  };
}

function parseAxes(raw: string): ContentRevisionAxis[] {
  try {
    const axes = JSON.parse(raw) as unknown[];
    return axes.filter((axis): axis is ContentRevisionAxis => axis === "headline" || axis === "html" || axis === "excerpt");
  } catch {
    return [];
  }
}

function mapRow(row: any): ContentRevision {
  return {
    id: Number(row.id),
    publicationId: Number(row.publication_id),
    blogId: String(row.blog_id),
    blogName: String(row.blog_name),
    platform: String(row.platform),
    platformPostId: String(row.platform_post_id),
    publicationUrl: String(row.publication_url),
    mutationKind: String(row.mutation_kind),
    axes: parseAxes(String(row.axes_json || "[]")),
    before: parseSnapshot(String(row.before_json)),
    after: parseSnapshot(String(row.after_json)),
    status: String(row.status) as ContentRevisionStatus,
    appliedUpdatedAt: row.applied_updated_at ? String(row.applied_updated_at) : null,
    rolledBackUpdatedAt: row.rolled_back_updated_at ? String(row.rolled_back_updated_at) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    appliedAt: row.applied_at ? String(row.applied_at) : null,
    rolledBackAt: row.rolled_back_at ? String(row.rolled_back_at) : null,
  };
}

const joinedSelect = `SELECT r.*, p.blog_id, p.platform_post_id, p.url publication_url,
  b.name blog_name, b.platform
  FROM content_revisions r
  JOIN publications p ON p.id=r.publication_id
  JOIN blogs b ON b.id=p.blog_id`;

export function prepareContentRevision(input: {
  publicationId: number;
  mutationKind: string;
  axes: ContentRevisionAxis[];
  before: ExistingPost;
  update: PostUpdate;
}): ContentRevision {
  if (!Number.isInteger(input.publicationId) || input.publicationId <= 0) throw new Error("publicationId must be a positive integer");
  const axes = [...new Set(input.axes)];
  if (!axes.length) throw new Error("revision snapshot requires at least one mutation axis");
  const before = cleanSnapshot(input.before);
  const after = intendedAfter(before, input.update);
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO content_revisions
    (publication_id,mutation_kind,axes_json,before_json,after_json,status,created_at)
    VALUES (?,?,?,?,?,'prepared',?)`).run(
      input.publicationId,
      String(input.mutationKind).slice(0, 80),
      JSON.stringify(axes),
      JSON.stringify(before),
      JSON.stringify(after),
      now,
    );
  const revision = getContentRevision(Number(info.lastInsertRowid));
  if (!revision) throw new Error("prepared revision snapshot could not be reloaded");
  return revision;
}

export function markContentRevisionApplied(revisionId: number, result: { updatedAt: string | null }): ContentRevision {
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE content_revisions
    SET status='applied',applied_updated_at=?,applied_at=?,error=NULL
    WHERE id=? AND status='prepared'`).run(result.updatedAt, now, revisionId);
  if (info.changes !== 1) throw new Error("revision snapshot is not in prepared state");
  const revision = getContentRevision(revisionId);
  if (!revision) throw new Error("applied revision snapshot could not be reloaded");
  return revision;
}

export function markContentRevisionFailed(revisionId: number, error: unknown): ContentRevision {
  const info = db.prepare(`UPDATE content_revisions SET status='failed',error=? WHERE id=? AND status='prepared'`)
    .run(safeError(error), revisionId);
  if (info.changes !== 1) throw new Error("revision snapshot is not in prepared state");
  const revision = getContentRevision(revisionId);
  if (!revision) throw new Error("failed revision snapshot could not be reloaded");
  return revision;
}

export function markContentRevisionRolledBack(revisionId: number, updatedAt: string | null): ContentRevision {
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE content_revisions
    SET status='rolled-back',rolled_back_at=?,rolled_back_updated_at=?
    WHERE id=? AND status='applied'`).run(now, updatedAt, revisionId);
  if (info.changes !== 1) throw new Error("revision is no longer eligible for rollback");
  const revision = getContentRevision(revisionId);
  if (!revision) throw new Error("rolled-back revision could not be reloaded");
  return revision;
}

export function getContentRevision(revisionId: number): ContentRevision | null {
  if (!Number.isInteger(revisionId) || revisionId <= 0) return null;
  const row = db.prepare(`${joinedSelect} WHERE r.id=?`).get(revisionId);
  return row ? mapRow(row) : null;
}

export function rollbackRevisionQueue(limit = 12): ContentRevision[] {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit || 12)));
  const rows = db.prepare(`${joinedSelect}
    WHERE r.status='applied'
    ORDER BY r.applied_at DESC, r.id DESC LIMIT ?`).all(safeLimit) as any[];
  return rows.map(mapRow);
}

export function stalePreparedRevisions(staleMinutes = 15, limit = 50): ContentRevision[] {
  const minutes = Math.max(1, Math.min(1440, Math.trunc(staleMinutes || 15)));
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit || 50)));
  const threshold = new Date(Date.now() - minutes * 60000).toISOString();
  const rows = db.prepare(`${joinedSelect}
    WHERE r.status='prepared' AND r.created_at <= ?
    ORDER BY r.created_at ASC, r.id ASC LIMIT ?`).all(threshold, safeLimit) as any[];
  return rows.map(mapRow);
}

export function revisionAttentionQueue(limit = 12, staleMinutes = 15): ContentRevision[] {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit || 12)));
  const threshold = new Date(Date.now() - Math.max(1, staleMinutes) * 60000).toISOString();
  const failedSince = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = db.prepare(`${joinedSelect}
    WHERE (r.status='prepared' AND r.created_at <= ?)
       OR (r.status='failed' AND r.created_at >= ?)
    ORDER BY CASE WHEN r.status='prepared' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
    LIMIT ?`).all(threshold, failedSince, safeLimit) as any[];
  return rows.map(mapRow);
}

export function contentRevisionOperationalSummary(staleMinutes = 15): ContentRevisionOperationalSummary {
  const threshold = new Date(Date.now() - Math.max(1, staleMinutes) * 60000).toISOString();
  const failedSince = new Date(Date.now() - 24 * 3600000).toISOString();
  const stale = db.prepare(`SELECT COUNT(*) n, MIN(created_at) oldest
    FROM content_revisions WHERE status='prepared' AND created_at <= ?`).get(threshold) as { n: number; oldest: string | null };
  const failed = db.prepare(`SELECT COUNT(*) n FROM content_revisions
    WHERE status='failed' AND created_at >= ?`).get(failedSince) as { n: number };
  return {
    stalePrepared: Number(stale.n || 0),
    failedRecent: Number(failed.n || 0),
    oldestStalePreparedAt: stale.oldest || null,
  };
}

export function revisionMatchesSnapshot(
  revision: ContentRevision,
  current: ExistingPost,
  target: "before" | "after",
): boolean {
  const snapshot = target === "before" ? revision.before : revision.after;
  if (revision.axes.includes("headline") && current.title !== snapshot.title) return false;
  if (revision.axes.includes("html") && current.html !== snapshot.html) return false;
  if (revision.axes.includes("excerpt") && current.excerpt !== snapshot.excerpt) return false;
  return true;
}

export function revisionRollbackUpdate(revision: ContentRevision): PostUpdate {
  const update: PostUpdate = {};
  if (revision.axes.includes("headline")) update.title = revision.before.title;
  if (revision.axes.includes("html")) update.html = revision.before.html;
  if (revision.axes.includes("excerpt")) update.excerpt = revision.before.excerpt;
  return update;
}

export function assertRevisionStillMatchesAppliedState(revision: ContentRevision, current: ExistingPost): void {
  if (revision.status !== "applied") throw new Error("revision is not eligible for rollback");
  if (!revisionMatchesSnapshot(revision, current, "after")) {
    throw new Error("Rollback blocked: the current remote content no longer matches the Blog Garden revision; a human or another process changed a recorded axis after automation.");
  }
}

export function publicationForRevision(revision: ContentRevision): Publication {
  const row = db.prepare("SELECT * FROM publications WHERE id=?").get(revision.publicationId) as any;
  if (!row) throw new Error("publication for revision no longer exists");
  return {
    id: Number(row.id),
    blogId: String(row.blog_id),
    platformPostId: String(row.platform_post_id),
    title: String(row.title),
    url: String(row.url),
    status: String(row.status),
    sourceUrls: JSON.parse(row.source_urls_json || "[]"),
    publishedAt: row.published_at || null,
    createdAt: String(row.created_at),
  };
}
