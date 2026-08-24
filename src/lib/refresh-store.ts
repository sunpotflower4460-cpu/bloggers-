import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Publication } from "./types";

type DB = InstanceType<typeof Database>;
export type RefreshOutcome = "win" | "loss" | "inconclusive";

export interface RefreshCandidate {
  publication: Publication;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  topQueries: string[];
}

export interface RefreshEvaluation {
  outcome: RefreshOutcome;
  beforeCtr: number;
  afterCtr: number;
  beforeImpressions: number;
  afterImpressions: number;
  beforePosition: number;
  afterPosition: number;
  ctrDelta: number;
  reason: string;
  evaluatedAt: string;
}

export interface ContentRefreshSummary {
  beforeTitle: string;
  afterTitle: string;
  hypothesis: string;
  reason: string;
  createdAt: string;
  outcome: RefreshOutcome | null;
  evaluation: RefreshEvaluation | null;
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
  outcome TEXT,
  evaluation_json TEXT,
  evaluated_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_publication_created ON content_refreshes(publication_id, created_at DESC);
`);

const refreshColumns = new Set((db.prepare("PRAGMA table_info(content_refreshes)").all() as Array<{ name: string }>).map((row) => row.name));
if (!refreshColumns.has("outcome")) db.exec("ALTER TABLE content_refreshes ADD COLUMN outcome TEXT");
if (!refreshColumns.has("evaluation_json")) db.exec("ALTER TABLE content_refreshes ADD COLUMN evaluation_json TEXT");
if (!refreshColumns.has("evaluated_at")) db.exec("ALTER TABLE content_refreshes ADD COLUMN evaluated_at TEXT");

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

function parseEvaluation(raw: unknown): RefreshEvaluation | null {
  if (!raw) return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return null;
    return value as RefreshEvaluation;
  } catch {
    return null;
  }
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

export function latestContentRefresh(blogId: string): ContentRefreshSummary | null {
  const row = db.prepare(`SELECT r.before_title,r.after_title,r.hypothesis,r.reason,r.created_at,r.outcome,r.evaluation_json
    FROM content_refreshes r JOIN publications p ON p.id=r.publication_id
    WHERE p.blog_id=? ORDER BY r.created_at DESC LIMIT 1`).get(blogId) as any;
  if (!row) return null;
  return {
    beforeTitle: String(row.before_title),
    afterTitle: String(row.after_title),
    hypothesis: String(row.hypothesis),
    reason: String(row.reason),
    createdAt: String(row.created_at),
    outcome: ["win", "loss", "inconclusive"].includes(String(row.outcome)) ? row.outcome as RefreshOutcome : null,
    evaluation: parseEvaluation(row.evaluation_json),
  };
}

function judgeRefresh(input: {
  beforeCtr: number;
  afterCtr: number;
  beforeImpressions: number;
  afterImpressions: number;
  beforePosition: number;
  afterPosition: number;
}): Omit<RefreshEvaluation, "evaluatedAt"> {
  const ctrDelta = input.afterCtr - input.beforeCtr;
  if (input.afterImpressions < 30) {
    return { ...input, ctrDelta, outcome: "inconclusive", reason: "Post-refresh search volume is still too small for a useful comparison." };
  }
  if (Math.abs(input.afterPosition - input.beforePosition) > 5) {
    return { ...input, ctrDelta, outcome: "inconclusive", reason: "Average ranking moved by more than five positions, so CTR change is confounded by ranking change." };
  }
  const meaningfulDelta = Math.max(0.005, input.beforeCtr * 0.2);
  if (ctrDelta >= meaningfulDelta) {
    return { ...input, ctrDelta, outcome: "win", reason: "CTR improved by a meaningful margin without a large ranking shift." };
  }
  if (ctrDelta <= -meaningfulDelta) {
    return { ...input, ctrDelta, outcome: "loss", reason: "CTR declined by a meaningful margin without a large ranking shift." };
  }
  return { ...input, ctrDelta, outcome: "inconclusive", reason: "CTR movement is too small to call confidently." };
}

export function evaluateDueRefreshes(blogId: string): RefreshEvaluation[] {
  // Search Console collection uses a finalized seven-day window ending three days ago.
  // Waiting 14 days means that window is fully post-refresh before we judge the result.
  const rows = db.prepare(`SELECT r.id,r.trigger_json,r.created_at,
      s.snapshot_date,s.clicks,s.impressions,s.ctr,s.position
    FROM content_refreshes r
    JOIN publications p ON p.id=r.publication_id
    JOIN search_snapshots s ON s.id=(
      SELECT s2.id FROM search_snapshots s2 WHERE s2.publication_id=r.publication_id ORDER BY s2.snapshot_date DESC LIMIT 1
    )
    WHERE p.blog_id=?
      AND r.evaluated_at IS NULL
      AND r.created_at <= datetime('now','-14 day')
      AND s.snapshot_date >= date(r.created_at,'+10 day')
    ORDER BY r.created_at ASC
    LIMIT 10`).all(blogId) as any[];

  const evaluated: RefreshEvaluation[] = [];
  const update = db.prepare("UPDATE content_refreshes SET outcome=?, evaluation_json=?, evaluated_at=? WHERE id=?");
  const now = new Date().toISOString();
  for (const row of rows) {
    let trigger: Record<string, unknown> = {};
    try { trigger = JSON.parse(row.trigger_json || "{}"); } catch { /* evaluate conservatively below */ }
    const beforeCtr = Number(trigger.ctr || 0);
    const beforeImpressions = Number(trigger.impressions || 0);
    const beforePosition = Number(trigger.position || 0);
    const base = judgeRefresh({
      beforeCtr,
      afterCtr: Number(row.ctr || 0),
      beforeImpressions,
      afterImpressions: Number(row.impressions || 0),
      beforePosition,
      afterPosition: Number(row.position || 0),
    });
    const evaluation: RefreshEvaluation = { ...base, evaluatedAt: now };
    update.run(evaluation.outcome, JSON.stringify(evaluation), now, row.id);
    evaluated.push(evaluation);
  }
  return evaluated;
}

export function refreshLearningContext(blogId: string): string {
  const rows = db.prepare(`SELECT r.before_title,r.after_title,r.hypothesis,r.outcome,r.evaluation_json
    FROM content_refreshes r JOIN publications p ON p.id=r.publication_id
    WHERE p.blog_id=? AND r.evaluated_at IS NOT NULL
    ORDER BY r.evaluated_at DESC LIMIT 8`).all(blogId) as any[];
  if (!rows.length) return "まだ評価済みの既存記事改善はない。検索意図に忠実な小さな変更を優先する。";
  return rows.map((row, i) => {
    const evaluation = parseEvaluation(row.evaluation_json);
    if (!evaluation) return `${i + 1}. ${row.before_title} → ${row.after_title} / outcome=${row.outcome || "inconclusive"}`;
    const before = Math.round(evaluation.beforeCtr * 1000) / 10;
    const after = Math.round(evaluation.afterCtr * 1000) / 10;
    const positionShift = Math.round((evaluation.afterPosition - evaluation.beforePosition) * 10) / 10;
    return `${i + 1}. ${row.before_title} → ${row.after_title} / outcome=${evaluation.outcome} / CTR ${before}%→${after}% / positionShift=${positionShift} / hypothesis=${row.hypothesis}`;
  }).join("\n");
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
