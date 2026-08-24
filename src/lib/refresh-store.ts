import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Publication } from "./types";

type DB = InstanceType<typeof Database>;

export interface RefreshCandidate {
  publication: Publication;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  topQueries: string[];
}

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenRefreshDb?: DB };
const db = globalDb.__blogGardenRefreshDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenRefreshDb = db;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS content_refreshes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  axis TEXT NOT NULL,
  before_title TEXT NOT NULL,
  after_title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  reason TEXT NOT NULL,
  trigger_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_publication_created ON content_refreshes(publication_id, created_at DESC);
`);

function toPublication(row: any): Publication {
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

export function findRefreshCandidate(blogId: string): RefreshCandidate | null {
  // One autonomous refresh per blog per week prevents a garden from endlessly polishing
  // existing pages while neglecting new publishing.
  const recentBlogRefresh = db.prepare(`SELECT 1 FROM content_refreshes r
    JOIN publications p ON p.id=r.publication_id
    WHERE p.blog_id=? AND r.created_at >= datetime('now','-7 day') LIMIT 1`).get(blogId);
  if (recentBlogRefresh) return null;

  const row = db.prepare(`SELECT p.*, s.clicks search_clicks, s.impressions search_impressions,
      s.ctr search_ctr, s.position search_position, s.top_queries_json
    FROM publications p
    JOIN search_snapshots s ON s.id=(
      SELECT s2.id FROM search_snapshots s2 WHERE s2.publication_id=p.id ORDER BY s2.snapshot_date DESC LIMIT 1
    )
    WHERE p.blog_id=?
      AND p.status='published'
      AND p.created_at <= datetime('now','-7 day')
      AND s.impressions >= 50
      AND s.ctr < 0.035
      AND s.position > 0 AND s.position <= 30
      AND NOT EXISTS (
        SELECT 1 FROM content_refreshes r WHERE r.publication_id=p.id AND r.created_at >= datetime('now','-21 day')
      )
    ORDER BY s.impressions DESC, s.ctr ASC
    LIMIT 1`).get(blogId) as any;
  if (!row) return null;
  let topQueries: string[] = [];
  try { topQueries = JSON.parse(row.top_queries_json || "[]"); } catch { /* ignore corrupt historic snapshot */ }
  return {
    publication: toPublication(row),
    clicks: Number(row.search_clicks || 0),
    impressions: Number(row.search_impressions || 0),
    ctr: Number(row.search_ctr || 0),
    position: Number(row.search_position || 0),
    topQueries: topQueries.slice(0, 8),
  };
}

export function recordContentRefresh(input: {
  publicationId: number;
  beforeTitle: string;
  afterTitle: string;
  hypothesis: string;
  reason: string;
  trigger: unknown;
  url?: string;
}): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO content_refreshes
      (publication_id,axis,before_title,after_title,hypothesis,reason,trigger_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        input.publicationId,
        "headline",
        input.beforeTitle,
        input.afterTitle,
        input.hypothesis,
        input.reason,
        JSON.stringify(input.trigger ?? {}),
        now,
      );
    if (input.url) db.prepare("UPDATE publications SET title=?, url=? WHERE id=?").run(input.afterTitle, input.url, input.publicationId);
    else db.prepare("UPDATE publications SET title=? WHERE id=?").run(input.afterTitle, input.publicationId);
  });
  tx();
}
