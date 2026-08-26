import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type DB = InstanceType<typeof Database>;
const MAX_PER_BLOG_CALL_LIMIT = 100_000;

export interface AiBudgetOverride {
  blogId: string;
  limit: number;
  updatedAt: string;
}

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenAiBudgetOverrideDb?: DB };
const db = globalDb.__blogGardenAiBudgetOverrideDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiBudgetOverrideDb = db;
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS blog_ai_budget_overrides (
  blog_id TEXT PRIMARY KEY,
  daily_call_limit INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`);

function cleanBlogId(value: string): string {
  const id = String(value || "").trim();
  if (!id || id.length > 240 || /[\r\n\t]/.test(id)) throw new Error("Invalid blog id for AI budget override");
  return id;
}

function validLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PER_BLOG_CALL_LIMIT) {
    throw new Error(`Blog AI daily call limit must be an integer between 1 and ${MAX_PER_BLOG_CALL_LIMIT}`);
  }
  return parsed;
}

export function parseBlogAiDailyCallLimit(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`ブログ別AI日次call上限は1〜${MAX_PER_BLOG_CALL_LIMIT}の整数で入力してください`);
  }
  return validLimit(Number(raw));
}

export function blogAiDailyCallLimitOverride(blogId: string): number | null {
  const id = cleanBlogId(blogId);
  const row = db.prepare("SELECT daily_call_limit FROM blog_ai_budget_overrides WHERE blog_id=?").get(id) as
    | { daily_call_limit: number }
    | undefined;
  if (!row) return null;
  return validLimit(row.daily_call_limit);
}

export function listBlogAiDailyCallLimitOverrides(): AiBudgetOverride[] {
  const rows = db.prepare(`SELECT blog_id,daily_call_limit,updated_at
    FROM blog_ai_budget_overrides ORDER BY updated_at DESC`).all() as Array<{
      blog_id: string;
      daily_call_limit: number;
      updated_at: string;
    }>;
  return rows.map((row) => ({
    blogId: cleanBlogId(row.blog_id),
    limit: validLimit(row.daily_call_limit),
    updatedAt: row.updated_at,
  }));
}

export function setBlogAiDailyCallLimitOverride(blogId: string, limit: number | null): void {
  const id = cleanBlogId(blogId);
  if (limit === null) {
    db.prepare("DELETE FROM blog_ai_budget_overrides WHERE blog_id=?").run(id);
    return;
  }
  const safeLimit = validLimit(limit);
  db.prepare(`INSERT INTO blog_ai_budget_overrides (blog_id,daily_call_limit,updated_at)
    VALUES (?,?,?)
    ON CONFLICT(blog_id) DO UPDATE SET
      daily_call_limit=excluded.daily_call_limit,
      updated_at=excluded.updated_at`)
    .run(id, safeLimit, new Date().toISOString());
}
