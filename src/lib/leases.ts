import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type DB = InstanceType<typeof Database>;

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenLeaseDb?: DB };
const db = globalDb.__blogGardenLeaseDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenLeaseDb = db;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS blog_leases (
  blog_id TEXT PRIMARY KEY REFERENCES blogs(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blog_leases_expires ON blog_leases(expires_at);
`);

export interface BlogLease {
  blogId: string;
  owner: string;
}

export function acquireBlogLease(blogId: string, ttlMinutes = 90): BlogLease | null {
  const owner = randomUUID();
  const ttl = Math.max(5, Math.min(240, Math.floor(ttlMinutes)));
  const modifier = `+${ttl} minutes`;
  const result = db.prepare(`INSERT INTO blog_leases (blog_id,owner,acquired_at,expires_at)
    VALUES (?, ?, datetime('now'), datetime('now', ?))
    ON CONFLICT(blog_id) DO UPDATE SET
      owner=excluded.owner,
      acquired_at=excluded.acquired_at,
      expires_at=excluded.expires_at
    WHERE blog_leases.expires_at <= datetime('now')`).run(blogId, owner, modifier);
  return result.changes > 0 ? { blogId, owner } : null;
}

export function releaseBlogLease(lease: BlogLease): void {
  db.prepare("DELETE FROM blog_leases WHERE blog_id=? AND owner=?").run(lease.blogId, lease.owner);
}

export function currentBlogLease(blogId: string): { acquiredAt: string; expiresAt: string } | null {
  const row = db.prepare(`SELECT acquired_at,expires_at FROM blog_leases
    WHERE blog_id=? AND expires_at > datetime('now')`).get(blogId) as { acquired_at: string; expires_at: string } | undefined;
  return row ? { acquiredAt: row.acquired_at, expiresAt: row.expires_at } : null;
}
