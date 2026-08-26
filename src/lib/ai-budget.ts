import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type DB = InstanceType<typeof Database>;

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
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(day_key, model_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_model_daily_day
  ON ai_usage_model_daily(day_key DESC);
`);

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
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
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

function rowFor(day: string): { calls: number; input_tokens: number; output_tokens: number; total_tokens: number } {
  const row = db.prepare("SELECT calls,input_tokens,output_tokens,total_tokens FROM ai_usage_daily WHERE day_key=?").get(day) as
    | { calls: number; input_tokens: number; output_tokens: number; total_tokens: number }
    | undefined;
  return row || { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function cleanModelKey(model: string): string {
  return String(model || "unknown").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "unknown";
}

function pruneModelUsage(): void {
  db.prepare("DELETE FROM ai_usage_model_daily WHERE julianday(day_key) < julianday('now','-120 day')").run();
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

export function aiUsageByModel(days = 7): AiModelUsageDaily[] {
  const keys = recentDayKeys(days);
  const placeholders = keys.map(() => "?").join(",");
  const rows = db.prepare(`SELECT day_key,model_key,calls,input_tokens,output_tokens,total_tokens
    FROM ai_usage_model_daily WHERE day_key IN (${placeholders}) ORDER BY day_key DESC,model_key ASC`).all(...keys) as Array<{
      day_key: string;
      model_key: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }>;
  return rows.map((row) => ({
    dayKey: row.day_key,
    modelKey: row.model_key,
    calls: Number(row.calls || 0),
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
  const reserve = db.transaction(() => {
    const current = rowFor(day);
    if (current.calls >= callLimit) {
      throw new Error(`AI daily call budget exhausted (${current.calls}/${callLimit})`);
    }
    if (current.total_tokens >= tokenLimit) {
      throw new Error(`AI daily token budget exhausted (${current.total_tokens}/${tokenLimit})`);
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
      (day_key,model_key,calls,input_tokens,output_tokens,total_tokens,updated_at)
      VALUES (?,?,1,0,0,0,?)
      ON CONFLICT(day_key,model_key) DO UPDATE SET
        calls=ai_usage_model_daily.calls+1,
        updated_at=excluded.updated_at`)
      .run(day, modelKey, now);
    pruneModelUsage();
  });
  reserve.immediate();
  return aiBudgetStatus();
}

export function recordAiUsage(usage: unknown, model: string): void {
  if (!usage || typeof usage !== "object") return;
  const raw = usage as Record<string, unknown>;
  const input = Math.max(0, Number(raw.input_tokens) || 0);
  const output = Math.max(0, Number(raw.output_tokens) || 0);
  const total = Math.max(0, Number(raw.total_tokens) || input + output);
  if (!input && !output && !total) return;
  const zone = timezone();
  const day = dayKey(new Date(), zone);
  const modelKey = cleanModelKey(model);
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
      .run(day, Math.floor(input), Math.floor(output), Math.floor(total), modelKey.slice(0, 160), now);
    db.prepare(`INSERT INTO ai_usage_model_daily
      (day_key,model_key,calls,input_tokens,output_tokens,total_tokens,updated_at)
      VALUES (?,?,0,?,?,?,?,?)
      ON CONFLICT(day_key,model_key) DO UPDATE SET
        input_tokens=ai_usage_model_daily.input_tokens+excluded.input_tokens,
        output_tokens=ai_usage_model_daily.output_tokens+excluded.output_tokens,
        total_tokens=ai_usage_model_daily.total_tokens+excluded.total_tokens,
        updated_at=excluded.updated_at`)
      .run(day, modelKey, Math.floor(input), Math.floor(output), Math.floor(total), now);
    pruneModelUsage();
  });
  record.immediate();
}
