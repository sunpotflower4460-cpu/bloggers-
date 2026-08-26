import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { blogAiDailyCallLimitOverride, listBlogAiDailyCallLimitOverrides } from "./ai-budget-overrides";
import { currentAiUsageScope } from "./ai-usage-context";

type DB = InstanceType<typeof Database>;
const MAX_USAGE_TOKEN_FIELD = 1_000_000_000;

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenAiBudgetDb?: DB };
const db = globalDb.__blogGardenAiBudgetDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiBudgetDb = db;
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day_key TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  last_model TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage_model_daily (
  day_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  metered_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(day_key, model_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_model_daily_day
  ON ai_usage_model_daily(day_key DESC);
CREATE TABLE IF NOT EXISTS ai_usage_scope_model_daily (
  day_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  model_key TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  metered_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(day_key, scope_key, model_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_scope_model_daily_day
  ON ai_usage_scope_model_daily(day_key DESC, scope_key);
`);

// F-032 is additive for databases that already created the model-usage table
// before metered_calls existed. We intentionally do not backfill historical
// rows as fully metered because a daily aggregate cannot prove that every call
// in that row returned usage. Conservative unknowns are safer than fake cost precision.
const modelUsageColumns = db.prepare("PRAGMA table_info(ai_usage_model_daily)").all() as Array<{ name: string }>;
if (!modelUsageColumns.some((column) => column.name === "metered_calls")) {
  db.exec("ALTER TABLE ai_usage_model_daily ADD COLUMN metered_calls INTEGER NOT NULL DEFAULT 0");
}

export interface AiBudgetStatus {
  dayKey: string;
  timezone: string;
  calls: number;
  callLimit: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenLimit: number;
  exhausted: boolean;
  utilization: number;
}

export interface AiModelUsageDaily {
  dayKey: string;
  modelKey: string;
  calls: number;
  meteredCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiScopeModelUsageDaily extends AiModelUsageDaily {
  scopeKey: string;
  scopeLabel: string;
}

export interface AiPerBlogBudgetScopeStatus {
  scopeKey: string;
  scopeLabel: string;
  calls: number;
  limit: number;
  limitSource: "override" | "default";
  exhausted: boolean;
  utilization: number;
}

export interface AiPerBlogBudgetStatus {
  configured: boolean;
  dayKey: string;
  timezone: string;
  limit: number | null;
  overrideCount: number;
  scopes: AiPerBlogBudgetScopeStatus[];
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function optionalPositiveInt(value: string | undefined, name: string, max: number): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer when configured`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function usageToken(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), MAX_USAGE_TOKEN_FIELD);
}

function timezone(): string {
  const configured = process.env.AI_BUDGET_TIMEZONE?.trim() || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: configured }).format(new Date());
    return configured;
  } catch {
    return "UTC";
  }
}

function dayKey(date = new Date(), zone = timezone()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function recentDayKeys(days: number, zone = timezone()): string[] {
  const count = Math.max(1, Math.min(90, Math.floor(days)));
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(dayKey(new Date(Date.now() - index * 86400000), zone));
  }
  return [...new Set(result)];
}

function limits(): { callLimit: number; tokenLimit: number } {
  return {
    callLimit: positiveInt(process.env.AI_DAILY_CALL_LIMIT, 100, 100_000),
    tokenLimit: positiveInt(process.env.AI_DAILY_TOKEN_LIMIT, 2_000_000, 1_000_000_000),
  };
}

function defaultPerBlogDailyCallLimit(): number | null {
  return optionalPositiveInt(process.env.AI_PER_BLOG_DAILY_CALL_LIMIT, "AI_PER_BLOG_DAILY_CALL_LIMIT", 100_000);
}

function blogIdFromScope(scopeKey: string): string | null {
  if (!scopeKey.startsWith("blog:")) return null;
  const blogId = scopeKey.slice("blog:".length).trim();
  return blogId || null;
}

export function aiPerBlogDailyCallLimit(scopeKey?: string): number | null {
  const blogId = scopeKey ? blogIdFromScope(scopeKey) : null;
  if (blogId) {
    const override = blogAiDailyCallLimitOverride(blogId);
    if (override !== null) return override;
  }
  return defaultPerBlogDailyCallLimit();
}

function rowFor(day: string): { calls: number; input_tokens: number; output_tokens: number; total_tokens: number } {
  const row = db.prepare("SELECT calls,input_tokens,output_tokens,total_tokens FROM ai_usage_daily WHERE day_key=?").get(day) as
    | { calls: number; input_tokens: number; output_tokens: number; total_tokens: number }
    | undefined;
  return row || { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function scopeCallsFor(day: string, scopeKey: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(calls),0) calls FROM ai_usage_scope_model_daily
    WHERE day_key=? AND scope_key=?`).get(day, scopeKey) as { calls: number } | undefined;
  return Number(row?.calls || 0);
}

function blogLabel(blogId: string): string {
  const exists = db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='blogs'").get() as { ok: number } | undefined;
  if (!exists) return blogId;
  try {
    const row = db.prepare("SELECT name FROM blogs WHERE id=?").get(blogId) as { name: string } | undefined;
    return String(row?.name || blogId).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || blogId;
  } catch {
    return blogId;
  }
}

function cleanModelKey(model: string): string {
  return String(model || "unknown").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "unknown";
}

function pruneUsage(): void {
  db.prepare("DELETE FROM ai_usage_model_daily WHERE julianday(day_key) < julianday('now','-120 day')").run();
  db.prepare("DELETE FROM ai_usage_scope_model_daily WHERE julianday(day_key) < julianday('now','-120 day')").run();
}

export function aiBudgetStatus(): AiBudgetStatus {
  const zone = timezone();
  const day = dayKey(new Date(), zone);
  const row = rowFor(day);
  const { callLimit, tokenLimit } = limits();
  const callRatio = row.calls / callLimit;
  const tokenRatio = row.total_tokens / tokenLimit;
  return {
    dayKey: day,
    timezone: zone,
    calls: row.calls,
    callLimit,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    tokenLimit,
    exhausted: row.calls >= callLimit || row.total_tokens >= tokenLimit,
    utilization: Math.max(callRatio, tokenRatio),
  };
}

export function aiPerBlogBudgetStatus(): AiPerBlogBudgetStatus {
  const zone = timezone();
  const day = dayKey(new Date(), zone);
  const defaultLimit = defaultPerBlogDailyCallLimit();
  const overrides = listBlogAiDailyCallLimitOverrides();
  const overrideByBlog = new Map(overrides.map((item) => [item.blogId, item.limit]));
  const usageRows = db.prepare(`SELECT scope_key,MAX(scope_label) scope_label,COALESCE(SUM(calls),0) calls
    FROM ai_usage_scope_model_daily
    WHERE day_key=? AND scope_key LIKE 'blog:%'
    GROUP BY scope_key`).all(day) as Array<{ scope_key: string; scope_label: string; calls: number }>;
  const usageByScope = new Map(usageRows.map((row) => [row.scope_key, row]));
  const scopeKeys = new Set(usageRows.map((row) => row.scope_key));
  for (const override of overrides) scopeKeys.add(`blog:${override.blogId}`);

  const scopes: AiPerBlogBudgetScopeStatus[] = [];
  for (const scopeKey of scopeKeys) {
    const blogId = blogIdFromScope(scopeKey);
    if (!blogId) continue;
    const override = overrideByBlog.get(blogId);
    const effectiveLimit = override ?? defaultLimit;
    if (effectiveLimit === null || effectiveLimit === undefined) continue;
    const usage = usageByScope.get(scopeKey);
    const calls = Number(usage?.calls || 0);
    scopes.push({
      scopeKey,
      scopeLabel: usage?.scope_label || blogLabel(blogId),
      calls,
      limit: effectiveLimit,
      limitSource: override !== undefined ? "override" : "default",
      exhausted: calls >= effectiveLimit,
      utilization: calls / effectiveLimit,
    });
  }
  scopes.sort((a, b) => b.utilization - a.utilization || b.calls - a.calls || a.scopeLabel.localeCompare(b.scopeLabel));

  return {
    configured: defaultLimit !== null || overrides.length > 0,
    dayKey: day,
    timezone: zone,
    limit: defaultLimit,
    overrideCount: overrides.length,
    scopes,
  };
}

export function aiUsageByModel(days = 7): AiModelUsageDaily[] {
  const keys = recentDayKeys(days);
  const placeholders = keys.map(() => "?").join(",");
  const rows = db.prepare(`SELECT day_key,model_key,calls,metered_calls,input_tokens,output_tokens,total_tokens
    FROM ai_usage_model_daily WHERE day_key IN (${placeholders}) ORDER BY day_key DESC,model_key ASC`).all(...keys) as Array<{
      day_key: string;
      model_key: string;
      calls: number;
      metered_calls: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }>;
  return rows.map((row) => ({
    dayKey: row.day_key,
    modelKey: row.model_key,
    calls: Number(row.calls || 0),
    meteredCalls: Number(row.metered_calls || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
  }));
}

export function aiUsageByScope(days = 7): AiScopeModelUsageDaily[] {
  const keys = recentDayKeys(days);
  const placeholders = keys.map(() => "?").join(",");
  const rows = db.prepare(`SELECT day_key,scope_key,scope_label,model_key,calls,metered_calls,input_tokens,output_tokens,total_tokens
    FROM ai_usage_scope_model_daily WHERE day_key IN (${placeholders})
    ORDER BY day_key DESC,scope_key ASC,model_key ASC`).all(...keys) as Array<{
      day_key: string;
      scope_key: string;
      scope_label: string;
      model_key: string;
      calls: number;
      metered_calls: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }>;
  return rows.map((row) => ({
    dayKey: row.day_key,
    scopeKey: row.scope_key,
    scopeLabel: row.scope_label,
    modelKey: row.model_key,
    calls: Number(row.calls || 0),
    meteredCalls: Number(row.metered_calls || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
  }));
}

export function reserveAiCall(model: string): AiBudgetStatus {
  const zone = timezone();
  const day = dayKey(new Date(), zone);
  const { callLimit, tokenLimit } = limits();
  const modelKey = cleanModelKey(model);
  const scope = currentAiUsageScope();
  const isBlogScope = scope.scopeKey.startsWith("blog:");
  const perBlogLimit = isBlogScope ? aiPerBlogDailyCallLimit(scope.scopeKey) : null;
  const reserve = db.transaction(() => {
    const current = rowFor(day);
    if (current.calls >= callLimit) {
      throw new Error(`AI daily call budget exhausted (${current.calls}/${callLimit})`);
    }
    if (current.total_tokens >= tokenLimit) {
      throw new Error(`AI daily token budget exhausted (${current.total_tokens}/${tokenLimit})`);
    }
    if (perBlogLimit !== null) {
      const scopedCalls = scopeCallsFor(day, scope.scopeKey);
      if (scopedCalls >= perBlogLimit) {
        throw new Error(`AI per-blog daily call budget exhausted for ${scope.scopeLabel} (${scopedCalls}/${perBlogLimit})`);
      }
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ai_usage_daily
      (day_key,calls,input_tokens,output_tokens,total_tokens,last_model,updated_at)
      VALUES (?,1,0,0,0,?,?)
      ON CONFLICT(day_key) DO UPDATE SET
        calls=ai_usage_daily.calls+1,
        last_model=excluded.last_model,
        updated_at=excluded.updated_at`)
      .run(day, modelKey.slice(0, 160), now);
    db.prepare(`INSERT INTO ai_usage_model_daily
      (day_key,model_key,calls,metered_calls,input_tokens,output_tokens,total_tokens,updated_at)
      VALUES (?,?,1,0,0,0,0,?)
      ON CONFLICT(day_key,model_key) DO UPDATE SET
        calls=ai_usage_model_daily.calls+1,
        updated_at=excluded.updated_at`)
      .run(day, modelKey, now);
    db.prepare(`INSERT INTO ai_usage_scope_model_daily
      (day_key,scope_key,scope_label,model_key,calls,metered_calls,input_tokens,output_tokens,total_tokens,updated_at)
      VALUES (?,?,?,?,1,0,0,0,0,?)
      ON CONFLICT(day_key,scope_key,model_key) DO UPDATE SET
        scope_label=excluded.scope_label,
        calls=ai_usage_scope_model_daily.calls+1,
        updated_at=excluded.updated_at`)
      .run(day, scope.scopeKey, scope.scopeLabel, modelKey, now);
    pruneUsage();
  });
  reserve.immediate();
  return aiBudgetStatus();
}

export function recordAiUsage(usage: unknown, model: string): void {
  if (!usage || typeof usage !== "object") return;
  const raw = usage as Record<string, unknown>;
  const input = usageToken(raw.input_tokens);
  const output = usageToken(raw.output_tokens);
  const reportedTotal = usageToken(raw.total_tokens);
  const total = Math.max(reportedTotal, input + output);
  if (!input && !output && !total) return;
  const zone = timezone();
  const day = dayKey(new Date(), zone);
  const modelKey = cleanModelKey(model);
  const scope = currentAiUsageScope();
  const now = new Date().toISOString();
  const record = db.transaction(() => {
    db.prepare(`INSERT INTO ai_usage_daily
      (day_key,calls,input_tokens,output_tokens,total_tokens,last_model,updated_at)
      VALUES (?,0,?,?,?,?,?)
      ON CONFLICT(day_key) DO UPDATE SET
        input_tokens=ai_usage_daily.input_tokens+excluded.input_tokens,
        output_tokens=ai_usage_daily.output_tokens+excluded.output_tokens,
        total_tokens=ai_usage_daily.total_tokens+excluded.total_tokens,
        last_model=excluded.last_model,
        updated_at=excluded.updated_at`)
      .run(day, input, output, total, modelKey.slice(0, 160), now);
    db.prepare(`INSERT INTO ai_usage_model_daily
      (day_key,model_key,calls,metered_calls,input_tokens,output_tokens,total_tokens,updated_at)
      VALUES (?,?,0,1,?,?,?,?)
      ON CONFLICT(day_key,model_key) DO UPDATE SET
        metered_calls=ai_usage_model_daily.metered_calls+1,
        input_tokens=ai_usage_model_daily.input_tokens+excluded.input_tokens,
        output_tokens=ai_usage_model_daily.output_tokens+excluded.output_tokens,
        total_tokens=ai_usage_model_daily.total_tokens+excluded.total_tokens,
        updated_at=excluded.updated_at`)
      .run(day, modelKey, input, output, total, now);
    db.prepare(`INSERT INTO ai_usage_scope_model_daily
      (day_key,scope_key,scope_label,model_key,calls,metered_calls,input_tokens,output_tokens,total_tokens,updated_at)
      VALUES (?,?,?,?,0,1,?,?,?,?)
      ON CONFLICT(day_key,scope_key,model_key) DO UPDATE SET
        scope_label=excluded.scope_label,
        metered_calls=ai_usage_scope_model_daily.metered_calls+1,
        input_tokens=ai_usage_scope_model_daily.input_tokens+excluded.input_tokens,
        output_tokens=ai_usage_scope_model_daily.output_tokens+excluded.output_tokens,
        total_tokens=ai_usage_scope_model_daily.total_tokens+excluded.total_tokens,
        updated_at=excluded.updated_at`)
      .run(day, scope.scopeKey, scope.scopeLabel, modelKey, input, output, total, now);
    pruneUsage();
  });
  record.immediate();
}
