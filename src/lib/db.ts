import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Blog, BlogPlatform, DashboardBlog, Publication, PublishMode, SourceCandidate } from "./types";

type DB = InstanceType<typeof Database>;

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
CREATE INDEX IF NOT EXISTS idx_runs_blog_started ON run_logs(blog_id, started_at DESC);
`);

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
    active: Boolean(row.active),
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
  };
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
    cadence_hours,daily_limit,language,timezone,ga4_property_id,active,last_run_at,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, input.niche, input.platform, input.siteUrl,
    JSON.stringify(input.keywords), JSON.stringify(input.feeds), input.credentialsCipher,
    input.publishMode, input.cadenceHours, input.dailyLimit, input.language, input.timezone,
    input.ga4PropertyId, input.active ? 1 : 0, null, now,
  );
  return getBlog(id)!;
}

export function setLastRun(blogId: string, at = new Date().toISOString()): void {
  db.prepare("UPDATE blogs SET last_run_at = ? WHERE id = ?").run(at, blogId);
}

export function countTodayPublications(blogId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM publications
    WHERE blog_id = ? AND date(created_at) = date('now')`).get(blogId) as { n: number };
  return row.n;
}

export function rememberSources(blogId: string, items: SourceCandidate[]): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO source_items
    (blog_id,title,url,summary,published_at,source,collected_at) VALUES (?,?,?,?,?,?,?)`);
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
  const info = db.prepare(`INSERT INTO publications
    (blog_id,platform_post_id,title,url,status,source_urls_json,published_at,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      input.blogId, input.platformPostId, input.title, input.url, input.status,
      JSON.stringify(input.sourceUrls), input.publishedAt, now,
    );
  return {
    ...input,
    id: Number(info.lastInsertRowid),
    createdAt: now,
  };
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
    VALUES (?,?,?,?,?)
    ON CONFLICT(publication_id,snapshot_date) DO UPDATE SET
      views=excluded.views,sessions=excluded.sessions,engaged_sessions=excluded.engaged_sessions`)
    .run(publicationId, date, views, sessions, engagedSessions);
}

export function performanceContext(blogId: string): string {
  const rows = db.prepare(`SELECT p.title,
    COALESCE(SUM(m.views),0) views,
    COALESCE(SUM(m.sessions),0) sessions,
    COALESCE(SUM(m.engaged_sessions),0) engaged
    FROM publications p
    LEFT JOIN metric_snapshots m ON m.publication_id=p.id AND m.snapshot_date >= date('now','-30 day')
    WHERE p.blog_id=?
    GROUP BY p.id
    ORDER BY views DESC
    LIMIT 8`).all(blogId) as Array<{title:string;views:number;sessions:number;engaged:number}>;
  if (!rows.length) return "まだ十分な実績データはない。初期探索を優先する。";
  return rows.map((r, i) => `${i + 1}. ${r.title} / views=${r.views} sessions=${r.sessions} engaged=${r.engaged}`).join("\n");
}

export function recordRun(blogId: string | null, kind: string, status: string, message: string, meta: unknown, startedAt: string): void {
  db.prepare(`INSERT INTO run_logs (blog_id,kind,status,message,meta_json,started_at,finished_at)
    VALUES (?,?,?,?,?,?,?)`).run(blogId, kind, status, message, JSON.stringify(meta ?? {}), startedAt, new Date().toISOString());
}

export function dashboard(): DashboardBlog[] {
  const blogs = listBlogs();
  return blogs.map((blog) => {
    const latest = db.prepare("SELECT title,url,published_at FROM publications WHERE blog_id=? ORDER BY created_at DESC LIMIT 1").get(blog.id) as any;
    const metrics = db.prepare(`SELECT COALESCE(SUM(m.views),0) views, COALESCE(SUM(m.sessions),0) sessions
      FROM metric_snapshots m JOIN publications p ON p.id=m.publication_id
      WHERE p.blog_id=? AND m.snapshot_date >= date('now','-7 day')`).get(blog.id) as any;
    const runs = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failed
      FROM run_logs WHERE blog_id=? AND started_at >= datetime('now','-7 day')`).get(blog.id) as any;
    return {
      ...blog,
      latestTitle: latest?.title ?? null,
      latestUrl: latest?.url ?? null,
      latestPublishedAt: latest?.published_at ?? null,
      views7d: Number(metrics?.views ?? 0),
      sessions7d: Number(metrics?.sessions ?? 0),
      recentRuns: Number(runs?.n ?? 0),
      failedRuns: Number(runs?.failed ?? 0),
    };
  });
}
