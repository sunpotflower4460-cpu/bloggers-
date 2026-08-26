import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aiBudgetStatus, aiPerBlogDailyCallLimit } from "./ai-budget";

export type AiBudgetPreflightReason =
  | "global-call-limit"
  | "global-token-limit"
  | "per-blog-call-limit";

export interface AiBudgetPreflightResult {
  blocked: boolean;
  reason: AiBudgetPreflightReason | null;
  detail: string;
  dayKey: string;
  timezone: string;
  calls: number | null;
  limit: number | null;
}

type DB = InstanceType<typeof Database>;
const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenAiBudgetPreflightDb?: DB };
const db = globalDb.__blogGardenAiBudgetPreflightDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiBudgetPreflightDb = db;
db.pragma("journal_mode = WAL");

function cleanBlogId(value: string): string {
  const id = String(value || "").trim();
  if (!id || id.length > 240 || /[\r\n\t]/.test(id)) throw new Error("Invalid blog id for AI budget preflight");
  return id;
}

function scopeCalls(dayKey: string, scopeKey: string): number {
  const exists = db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='ai_usage_scope_model_daily'").get() as
    | { ok: number }
    | undefined;
  if (!exists) return 0;
  const row = db.prepare(`SELECT COALESCE(SUM(calls),0) calls
    FROM ai_usage_scope_model_daily WHERE day_key=? AND scope_key=?`).get(dayKey, scopeKey) as
    | { calls: number }
    | undefined;
  return Number(row?.calls || 0);
}

/**
 * Advisory early-stop check for F-043. This never replaces reserveAiCall():
 * concurrent work can consume the last slot after this check, so the atomic
 * reservation remains the final authoritative guard immediately before every
 * outbound AI request.
 */
export function aiBudgetPreflightForBlog(blogId: string, blogLabel?: string): AiBudgetPreflightResult {
  const id = cleanBlogId(blogId);
  const label = String(blogLabel || id).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || id;
  const global = aiBudgetStatus();

  if (global.calls >= global.callLimit) {
    return {
      blocked: true,
      reason: "global-call-limit",
      detail: `AI global daily call budget exhausted (${global.calls}/${global.callLimit}) for ${global.dayKey} (${global.timezone})`,
      dayKey: global.dayKey,
      timezone: global.timezone,
      calls: global.calls,
      limit: global.callLimit,
    };
  }

  if (global.totalTokens >= global.tokenLimit) {
    return {
      blocked: true,
      reason: "global-token-limit",
      detail: `AI global daily token budget exhausted (${global.totalTokens}/${global.tokenLimit}) for ${global.dayKey} (${global.timezone})`,
      dayKey: global.dayKey,
      timezone: global.timezone,
      calls: global.totalTokens,
      limit: global.tokenLimit,
    };
  }

  const scopeKey = `blog:${id}`;
  const perBlogLimit = aiPerBlogDailyCallLimit(scopeKey);
  if (perBlogLimit !== null) {
    const calls = scopeCalls(global.dayKey, scopeKey);
    if (calls >= perBlogLimit) {
      return {
        blocked: true,
        reason: "per-blog-call-limit",
        detail: `AI per-blog daily call budget exhausted for ${label} (${calls}/${perBlogLimit}) for ${global.dayKey} (${global.timezone})`,
        dayKey: global.dayKey,
        timezone: global.timezone,
        calls,
        limit: perBlogLimit,
      };
    }
  }

  return {
    blocked: false,
    reason: null,
    detail: "AI budget has capacity for another protected editorial attempt",
    dayKey: global.dayKey,
    timezone: global.timezone,
    calls: null,
    limit: null,
  };
}
