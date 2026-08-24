import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Blog, BlogPlatform, DashboardBlog, EditorialExperiment, Publication, PublishMode, SourceCandidate } from "./types";

type DB = InstanceType<typeof Database>;

type UpdateBlogInput = Pick<Blog, "name" | "niche" | "siteUrl" | "keywords" | "feeds" | "publishMode" | "cadenceHours" | "dailyLimit" | "ga4PropertyId" | "searchConsoleSiteUrl"> & {
  credentialsCipher?: string;
};

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });

const globalDb = globalThis as typeof globalThis & { __blogGardenDb?: DB };
const db = globalDb.__blogGardenDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenDb = db;

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS blogs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL,
  platform TEXT NOT NULL,
  site_url TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  feeds_json TEXT NOT NULL DEFAULT '[]',
  credentials_cipher TEXT NOT NULL,
  publish_mode TEXT NOT NULL,
  cadence_hours INTEGER NOT NULL DEFAULT 24,
  daily_limit INTEGER NOT NULL DEFAULT 1,
  language TEXT NOT NULL DEFAULT 'ja',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  ga4_property_id TEXT,
  search_console_site_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE(blog_id, url)
);
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  platform_post_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  published_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  engaged_sessions INTEGER NOT NULL DEFAULT 0,
  UNIQUE(publication_id, snapshot_date)
);
CREATE TABLE IF NOT EXISTS reaction_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  comments INTEGER NOT NULL DEFAULT 0,
  UNIQUE(publication_id, snapshot_date)
);
CREATE TABLE IF NOT EXISTS search_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  top_queries_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(publication_id, snapshot_date)
);
CREATE TABLE IF NOT EXISTS editorial_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL UNIQUE REFERENCES publications(id) ON DELETE CASCADE,
  axis TEXT NOT NULL,
  variant TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT REFERENCES blogs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publications_blog_created ON publications(blog_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_publication_date ON metric_snapshots(publication_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_reactions_publication_date ON reaction_snapshots(publication_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_search_publication_date ON search_snapshots(publication_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_runs_blog_started ON run_logs(blog_id, started_at DESC);
`);

const blogColumns = new Set((db.prepare("PRAGMA table_info(blogs)").all() as Array<{ name: string }>).map((row) => row.name));
if (!blogColumns.has("search_console_site_url")) db.exec("ALTER TABLE blogs ADD COLUMN search_console_site_url TEXT");

function rowToBlog(row: any): Blog {
  return {
    id: row.id,
    name: row.name,
    niche: row.niche,
    platform: row.platform as BlogPlatform,
    siteUrl: row.site_url,
    keywords: JSON.parse(row.keywords_json),
    feeds: JSON.parse(row.feeds_json),
    credentialsCipher: row.credentials_cipher,
    publishMode: row.publish_mode as PublishMode,
    cadenceHours: row.cadence_hours,
    dailyLimit: row.daily_limit,
    language: row.language,
    timezone: row.timezone,
    ga4PropertyId: row.ga4_property_id,
    searchConsoleSiteUrl: row.search_console_site_url,
    active: Boolean(row.active),
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
  };
}

function localDayKey(value: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  }
}

export function listBlogs(): Blog[] {
  return db.prepare("SELECT * FROM blogs ORDER BY created_at ASC").all().map(rowToBlog);
}

export function getBlog(id: string): Blog | null {
  const row = db.prepare("SELECT * FROM blogs WHERE id = ?").get(id);
  return row ? rowToBlog(row) : null;
}

export function createBlog(input: Omit<Blog, "id" | "lastRunAt" | "createdAt">): Blog {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`INSERT INTO blogs (
    id,name,niche,platform,site_url,keywords_json,feeds_json,credentials_cipher,publish_mode,
    cadence_hours,daily_limit,language,timezone,ga4_property_id,search_console_site_url,active,last_run_at,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, input.niche, input.platform, input.siteUrl,
    JSON.stringify(input.keywords), JSON.stringify(input.feeds), input.credentialsCipher,
    input.publishMode, input.cadenceHours, input.dailyLimit, input.language, input.timezone,
    input.ga4PropertyId, input.searchConsoleSiteUrl, input.active ? 1 : 0, null, now,
  );
  return getBlog(id)!;
}

export function updateBlog(blogId: string, input: UpdateBlogInput): Blog | null {
  const current = getBlog(blogId);
  if (!current) return null;
  db.prepare(`UPDATE blogs SET
    name=?, niche=?, site_url=?, keywords_json=?, feeds_json=?, credentials_cipher=?, publish_mode=?,
    cadence_hours=?, daily_limit=?, ga4_property_id=?, search_console_site_url=? WHERE id=?`).run(
      input.name,
      input.niche,
      input.siteUrl,
      JSON.stringify(input.keywords),
      JSON.stringify(input.feeds),
      input.credentialsCipher ?? current.credentialsCipher,
      input.publishMode,
      input.cadenceHours,
      input.dailyLimit,
      input.ga4PropertyId,
      input.searchConsoleSiteUrl,
      blogId,
    );
  return getBlog(blogId);
}

export function setBlogActive(blogId: string, active: boolean): Blog | null {
  db.prepare("UPDATE blogs SET active = ? WHERE id = ?").run(active ? 1 : 0, blogId);
  return getBlog(blogId);
}

export function setLastRun(blogId: string, at = new Date().toISOString()): void {
  db.prepare("UPDATE blogs SET last_run_at = ? WHERE id = ?").run(at, blogId);
}

export function countTodayPublications(blogId: string, timezone: string): number {
  const since = new Date(Date.now() - 36 * 3600000).toISOString();
  const rows = db.prepare("SELECT created_at FROM publications WHERE blog_id = ? AND created_at >= ?").all(blogId, since) as Array<{ created_at: string }>;
  const today = localDayKey(new Date(), timezone);
  return rows.filter((row) => localDayKey(new Date(row.created_at), timezone) === today).length;
}

export function rememberSources(blogId: string, items: SourceCandidate[]): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO source_items (blog_id,title,url,summary,published_at,source,collected_at) VALUES (?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  const tx = db.transaction((rows: SourceCandidate[]) => {
    for (const item of rows) stmt.run(blogId, item.title, item.url, item.summary, item.publishedAt, item.source, now);
  });
  tx(items);
}

export function recentTitles(blogId: string, limit = 30): string[] {
  return (db.prepare("SELECT title FROM publications WHERE blog_id = ? ORDER BY created_at DESC LIMIT ?").all(blogId, limit) as Array<{title:string}>).map((r) => r.title);
}

export function recordPublication(input: Omit<Publication, "id" | "createdAt">): Publication {
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO publications (blog_id,platform_post_id,title,url,status,source_urls_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
    input.blogId, input.platformPostId, input.title, input.url, input.status, JSON.stringify(input.sourceUrls), input.publishedAt, now,
  );
  return { ...input, id: Number(info.lastInsertRowid), createdAt: now };
}

export function recentPublications(blogId: string, limit = 50): Publication[] {
  const rows = db.prepare("SELECT * FROM publications WHERE blog_id = ? ORDER BY created_at DESC LIMIT ?").all(blogId, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    blogId: r.blog_id,
    platformPostId: r.platform_post_id,
    title: r.title,
    url: r.url,
    status: r.status,
    sourceUrls: JSON.parse(r.source_urls_json),
    publishedAt: r.published_at,
    createdAt: r.created_at,
  }));
}

export function upsertMetric(publicationId: number, date: string, views: number, sessions: number, engagedSessions: number): void {
  db.prepare(`INSERT INTO metric_snapshots (publication_id,snapshot_date,views,sessions,engaged_sessions)
    VALUES (?,?,?,?,?) ON CONFLICT(publication_id,snapshot_date) DO UPDATE SET
    views=excluded.views,sessions=excluded.sessions,engaged_sessions=excluded.engaged_sessions`).run(publicationId, date, views, sessions, engagedSessions);
}

export function upsertReaction(publicationId: number, date: string, comments: number): void {
  db.prepare(`INSERT INTO reaction_snapshots (publication_id,snapshot_date,comments)
    VALUES (?,?,?) ON CONFLICT(publication_id,snapshot_date) DO UPDATE SET comments=excluded.comments`).run(publicationId, date, comments);
}

export function upsertSearchSnapshot(publicationId: number, date: string, clicks: number, impressions: number, ctr: number, position: number, topQueries: string[]): void {
  db.prepare(`INSERT INTO search_snapshots (publication_id,snapshot_date,clicks,impressions,ctr,position,top_queries_json)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(publication_id,snapshot_date) DO UPDATE SET
    clicks=excluded.clicks,impressions=excluded.impressions,ctr=excluded.ctr,position=excluded.position,top_queries_json=excluded.top_queries_json`)
    .run(publicationId, date, clicks, impressions, ctr, position, JSON.stringify(topQueries.slice(0, 8)));
}

export function recordExperiment(publicationId: number, experiment?: EditorialExperiment): void {
  if (!experiment) return;
  const axis = ["headline", "angle", "structure"].includes(experiment.axis) ? experiment.axis : "angle";
  const variant = String(experiment.variant || "").trim().slice(0, 240);
  const hypothesis = String(experiment.hypothesis || "").trim().slice(0, 600);
  if (!variant || !hypothesis) return;
  db.prepare(`INSERT OR REPLACE INTO editorial_experiments (publication_id,axis,variant,hypothesis,created_at) VALUES (?,?,?,?,?)`)
    .run(publicationId, axis, variant, hypothesis, new Date().toISOString());
}

export function experimentContext(blogId: string): string {
  const rows = db.prepare(`SELECT e.axis,e.variant,e.hypothesis,p.title,
    COALESCE((SELECT SUM(m.views) FROM metric_snapshots m WHERE m.publication_id=p.id AND m.snapshot_date >= date('now','-6 day')),0) views7,
    COALESCE((SELECT s.clicks FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_clicks,
    COALESCE((SELECT s.impressions FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_impressions,
    COALESCE((SELECT s.ctr FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_ctr,
    COALESCE((SELECT s.position FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_position,
    COALESCE((SELECT r.comments FROM reaction_snapshots r WHERE r.publication_id=p.id ORDER BY r.snapshot_date DESC LIMIT 1),0) comments
    FROM editorial_experiments e JOIN publications p ON p.id=e.publication_id
    WHERE p.blog_id=? ORDER BY e.created_at DESC LIMIT 10`).all(blogId) as Array<{
      axis:string;variant:string;hypothesis:string;title:string;views7:number;search_clicks:number;search_impressions:number;search_ctr:number;search_position:number;comments:number;
    }>;
  if (!rows.length) return "まだ編集実験の履歴はない。今回は小さく検証可能な仮説を1つだけ設定する。";
  return rows.map((row, i) => `${i + 1}. axis=${row.axis} / variant=${row.variant} / hypothesis=${row.hypothesis} / article=${row.title} / views7=${row.views7} / search=${row.search_clicks} clicks, ${row.search_impressions} impressions, CTR=${Math.round(row.search_ctr * 1000) / 10}%, position=${Math.round(row.search_position * 10) / 10 || "n/a"} / comments=${row.comments}`).join("\n");
}

export function performanceContext(blogId: string): string {
  const rows = db.prepare(`SELECT p.id, p.title,
    COALESCE(SUM(CASE WHEN m.snapshot_date >= date('now','-6 day') THEN m.views ELSE 0 END),0) views7,
    COALESCE(SUM(CASE WHEN m.snapshot_date BETWEEN date('now','-13 day') AND date('now','-7 day') THEN m.views ELSE 0 END),0) prev7,
    COALESCE(SUM(CASE WHEN m.snapshot_date >= date('now','-29 day') THEN m.sessions ELSE 0 END),0) sessions30,
    COALESCE(SUM(CASE WHEN m.snapshot_date >= date('now','-29 day') THEN m.engaged_sessions ELSE 0 END),0) engaged30,
    COALESCE((SELECT r.comments FROM reaction_snapshots r WHERE r.publication_id=p.id ORDER BY r.snapshot_date DESC LIMIT 1),0) comments,
    COALESCE((SELECT s.clicks FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_clicks,
    COALESCE((SELECT s.impressions FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_impressions,
    COALESCE((SELECT s.ctr FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_ctr,
    COALESCE((SELECT s.position FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),0) search_position,
    COALESCE((SELECT s.top_queries_json FROM search_snapshots s WHERE s.publication_id=p.id ORDER BY s.snapshot_date DESC LIMIT 1),'[]') top_queries_json
    FROM publications p
    LEFT JOIN metric_snapshots m ON m.publication_id=p.id AND m.snapshot_date >= date('now','-29 day')
    WHERE p.blog_id=?
    GROUP BY p.id
    ORDER BY views7 DESC, search_impressions DESC, comments DESC
    LIMIT 8`).all(blogId) as Array<{title:string;views7:number;prev7:number;sessions30:number;engaged30:number;comments:number;search_clicks:number;search_impressions:number;search_ctr:number;search_position:number;top_queries_json:string}>;
  if (!rows.length) return "まだ十分な実績データはない。初期探索を優先する。";
  return rows.map((r, i) => {
    const momentum = r.prev7 > 0 ? Math.round(((r.views7 - r.prev7) / r.prev7) * 100) : null;
    const engagement = r.sessions30 > 0 ? Math.round((r.engaged30 / r.sessions30) * 100) : null;
    let queries: string[] = [];
    try { queries = JSON.parse(r.top_queries_json); } catch { /* old/corrupt snapshot */ }
    return `${i + 1}. ${r.title} / views7=${r.views7} / previous7=${r.prev7} / momentum=${momentum === null ? "new" : `${momentum}%`} / engagement30=${engagement === null ? "n/a" : `${engagement}%`} / comments=${r.comments} / searchClicks=${r.search_clicks} / impressions=${r.search_impressions} / searchCTR=${Math.round(r.search_ctr * 1000) / 10}% / avgPosition=${r.search_position ? Math.round(r.search_position * 10) / 10 : "n/a"} / queries=${queries.slice(0, 5).join(" | ") || "n/a"}`;
  }).join("\n");
}

export function recordRun(blogId: string | null, kind: string, status: string, message: string, meta: unknown, startedAt: string): void {
  db.prepare(`INSERT INTO run_logs (blog_id,kind,status,message,meta_json,started_at,finished_at) VALUES (?,?,?,?,?,?,?)`).run(
    blogId, kind, status, message, JSON.stringify(meta ?? {}), startedAt, new Date().toISOString(),
  );
}

export function dashboard(): DashboardBlog[] {
  return listBlogs().map((blog) => {
    const latest = db.prepare("SELECT title,url,published_at FROM publications WHERE blog_id=? ORDER BY created_at DESC LIMIT 1").get(blog.id) as any;
    const metrics = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN m.snapshot_date >= date('now','-6 day') THEN m.views ELSE 0 END),0) views7,
      COALESCE(SUM(CASE WHEN m.snapshot_date BETWEEN date('now','-13 day') AND date('now','-7 day') THEN m.views ELSE 0 END),0) prev7,
      COALESCE(SUM(CASE WHEN m.snapshot_date >= date('now','-6 day') THEN m.sessions ELSE 0 END),0) sessions7,
      COALESCE(SUM(CASE WHEN m.snapshot_date >= date('now','-6 day') THEN m.engaged_sessions ELSE 0 END),0) engaged7
      FROM metric_snapshots m JOIN publications p ON p.id=m.publication_id
      WHERE p.blog_id=? AND m.snapshot_date >= date('now','-13 day')`).get(blog.id) as any;
    const native = db.prepare(`SELECT COALESCE(SUM((SELECT r.comments FROM reaction_snapshots r WHERE r.publication_id=p.id ORDER BY r.snapshot_date DESC LIMIT 1)),0) comments FROM publications p WHERE p.blog_id=?`).get(blog.id) as any;
    const search = db.prepare(`SELECT
      COALESCE(SUM(s.clicks),0) clicks,
      COALESCE(SUM(s.impressions),0) impressions,
      CASE WHEN SUM(s.impressions) > 0 THEN SUM(s.clicks) / SUM(s.impressions) ELSE NULL END ctr,
      CASE WHEN SUM(s.impressions) > 0 THEN SUM(s.position * s.impressions) / SUM(s.impressions) ELSE NULL END position
      FROM publications p JOIN search_snapshots s ON s.id=(SELECT s2.id FROM search_snapshots s2 WHERE s2.publication_id=p.id ORDER BY s2.snapshot_date DESC LIMIT 1)
      WHERE p.blog_id=?`).get(blog.id) as any;
    const topQueryRow = db.prepare(`SELECT s.top_queries_json FROM publications p JOIN search_snapshots s ON s.id=(SELECT s2.id FROM search_snapshots s2 WHERE s2.publication_id=p.id ORDER BY s2.snapshot_date DESC LIMIT 1) WHERE p.blog_id=? ORDER BY s.impressions DESC LIMIT 1`).get(blog.id) as { top_queries_json?: string } | undefined;
    const runs = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failed FROM run_logs WHERE blog_id=? AND started_at >= datetime('now','-7 day')`).get(blog.id) as any;
    const views7d = Number(metrics?.views7 ?? 0);
    const viewsPrev7d = Number(metrics?.prev7 ?? 0);
    const sessions7d = Number(metrics?.sessions7 ?? 0);
    const engagedSessions7d = Number(metrics?.engaged7 ?? 0);
    let topQueries: string[] = [];
    try { topQueries = JSON.parse(topQueryRow?.top_queries_json || "[]"); } catch { /* ignore */ }
    return {
      ...blog,
      latestTitle: latest?.title ?? null,
      latestUrl: latest?.url ?? null,
      latestPublishedAt: latest?.published_at ?? null,
      views7d,
      viewsPrev7d,
      sessions7d,
      engagedSessions7d,
      momentumPercent: viewsPrev7d > 0 ? Math.round(((views7d - viewsPrev7d) / viewsPrev7d) * 100) : null,
      engagementRate: sessions7d > 0 ? Math.round((engagedSessions7d / sessions7d) * 100) : null,
      nativeComments: Number(native?.comments ?? 0),
      searchClicks: Number(search?.clicks ?? 0),
      searchImpressions: Number(search?.impressions ?? 0),
      searchCtrPercent: search?.ctr == null ? null : Math.round(Number(search.ctr) * 1000) / 10,
      searchPosition: search?.position == null ? null : Math.round(Number(search.position) * 10) / 10,
      topSearchQuery: topQueries[0] || null,
      recentRuns: Number(runs?.n ?? 0),
      failedRuns: Number(runs?.failed ?? 0),
    };
  });
}
