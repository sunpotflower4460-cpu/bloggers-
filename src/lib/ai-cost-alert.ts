import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aiCostEstimate } from "./ai-cost";

type DB = InstanceType<typeof Database>;
type AlertKind = "warning" | "recovery";

interface IncidentRow {
  status: "open" | "closed";
  detail: string;
  last_notified_at: string | null;
}

export interface AiCostThresholds {
  daily: number | null;
  projected30d: number | null;
}

const code = "ai-estimated-cost-threshold";
const scope = "system";
const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenAiCostAlertDb?: DB };
const db = globalDb.__blogGardenAiCostAlertDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiCostAlertDb = db;
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS operational_incidents (
  code TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_notified_at TEXT,
  resolved_at TEXT,
  PRIMARY KEY(code, scope)
);
`);

function now(): string {
  return new Date().toISOString();
}

function hoursSince(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000);
}

function safe(value: unknown): string {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function optionalThreshold(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1_000_000_000) {
    throw new Error(`${name} must be a finite positive number <= 1000000000`);
  }
  return parsed;
}

export function aiCostThresholds(): AiCostThresholds {
  return {
    daily: optionalThreshold("AI_ESTIMATED_DAILY_COST_WARN"),
    projected30d: optionalThreshold("AI_ESTIMATED_30D_COST_WARN"),
  };
}

function webhookKind(url: URL): "slack" | "discord" | "generic" {
  const configured = (process.env.ALERT_WEBHOOK_KIND || "auto").toLowerCase();
  if (configured === "slack" || configured === "discord" || configured === "generic") return configured;
  if (url.hostname === "hooks.slack.com") return "slack";
  if (url.hostname === "discord.com" || url.hostname === "discordapp.com") return "discord";
  return "generic";
}

async function send(kind: AlertKind, detail: string): Promise<boolean> {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return false;
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("ALERT_WEBHOOK_URL must use HTTPS in production");
  }
  const marker = kind === "warning" ? "WARNING" : "RECOVERY";
  const text = `[Blog Garden][${marker}] ${scope} / ${code}\n${safe(detail)}`;
  const target = webhookKind(url);
  const body = target === "slack"
    ? { text }
    : target === "discord"
      ? { content: text.slice(0, 1900) }
      : { text, severity: kind, code, scope, detail: safe(detail), at: now() };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`AI cost alert webhook failed with HTTP ${response.status}`);
  return true;
}

function money(value: number, currency: string): string {
  return `${currency} ${value.toFixed(value < 10 ? 4 : 2)}`;
}

export async function reconcileAiCostThresholdIncident(): Promise<{
  enabled: boolean;
  exceeded: boolean;
  observable: boolean;
  notified: boolean;
  notificationFailure: boolean;
}> {
  const thresholds = aiCostThresholds();
  const enabled = thresholds.daily !== null || thresholds.projected30d !== null;
  const existing = db.prepare("SELECT status,detail,last_notified_at FROM operational_incidents WHERE code=? AND scope=?")
    .get(code, scope) as IncidentRow | undefined;
  const timestamp = now();
  let notified = false;
  let notificationFailure = false;

  if (!enabled) {
    if (existing?.status === "open") {
      const detail = "AI推定コスト閾値監視が設定から無効化されました。これはコストが閾値未満になったことを意味しません。";
      db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
        .run(detail, timestamp, timestamp, code, scope);
      try {
        notified = await send("recovery", detail);
        if (notified) db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?").run(now(), code, scope);
      } catch (error) {
        notificationFailure = true;
        console.error(`[ai-cost-alert] disabled notification failed: ${safe(error instanceof Error ? error.message : error)}`);
      }
    }
    return { enabled: false, exceeded: false, observable: false, notified, notificationFailure };
  }

  const estimate = aiCostEstimate();
  const observable = estimate.configured;
  if (!observable) {
    // Never manufacture a low-cost recovery when pricing is unavailable. An
    // already-open threshold incident remains open until observability returns
    // or the operator explicitly disables threshold monitoring.
    if (existing?.status === "open") {
      const detail = "AI推定コスト閾値は有効ですが、単価表が未設定のため現在の復旧可否を確認できません。incidentをOPENのまま維持します。";
      db.prepare("UPDATE operational_incidents SET detail=?,updated_at=? WHERE code=? AND scope=?")
        .run(detail, timestamp, code, scope);
    }
    return { enabled: true, exceeded: false, observable: false, notified: false, notificationFailure: false };
  }

  const dailyExceeded = thresholds.daily !== null && estimate.todayEstimatedCost >= thresholds.daily;
  const projectedExceeded = thresholds.projected30d !== null && estimate.projected30dCost >= thresholds.projected30d;
  const exceeded = dailyExceeded || projectedExceeded;
  const thresholdText = [
    thresholds.daily !== null ? `daily warn=${money(thresholds.daily, estimate.currency)}` : null,
    thresholds.projected30d !== null ? `30d warn=${money(thresholds.projected30d, estimate.currency)}` : null,
  ].filter(Boolean).join(", ");
  const estimateText = `today=${money(estimate.todayEstimatedCost, estimate.currency)}, projected30d=${money(estimate.projected30dCost, estimate.currency)}`;
  const coverageText = `coverage=${estimate.coveragePercent === null ? "n/a" : `${estimate.coveragePercent.toFixed(1)}%`}, unmeteredCalls=${estimate.unmeteredCalls}, unpricedModels=${estimate.unpricedModelKeys.length}`;

  if (exceeded) {
    const detail = `AI推定コストが運用者設定のwarning閾値以上です: ${estimateText}; ${thresholdText}; ${coverageText}. 推定が部分的でも、観測済みの価格付き部分だけで閾値へ到達しています。自動停止・route変更は行いません。`;
    if (!existing) {
      db.prepare(`INSERT INTO operational_incidents
        (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
        VALUES (?,?, 'open','warning',?,?,?,NULL,NULL)`)
        .run(code, scope, detail, timestamp, timestamp);
    } else {
      db.prepare(`UPDATE operational_incidents SET status='open',severity='warning',detail=?,updated_at=?,resolved_at=NULL WHERE code=? AND scope=?`)
        .run(detail, timestamp, code, scope);
    }
    const shouldNotify = !existing || existing.status === "closed" || hoursSince(existing.last_notified_at) >= 48;
    if (shouldNotify) {
      try {
        if (await send("warning", detail)) {
          notified = true;
          db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?").run(now(), code, scope);
        }
      } catch (error) {
        notificationFailure = true;
        console.error(`[ai-cost-alert] notification failed: ${safe(error instanceof Error ? error.message : error)}`);
      }
    }
    return { enabled: true, exceeded: true, observable: true, notified, notificationFailure };
  }

  if (existing?.status === "open") {
    if (!estimate.complete) {
      const detail = `観測済みAI推定コストはwarning閾値未満ですが、推定coverageが不完全なため復旧を確定できません: ${estimateText}; ${thresholdText}; ${coverageText}. incidentをOPENのまま維持します。`;
      db.prepare("UPDATE operational_incidents SET detail=?,updated_at=? WHERE code=? AND scope=?")
        .run(detail, timestamp, code, scope);
      return { enabled: true, exceeded: false, observable: true, notified: false, notificationFailure: false };
    }

    const detail = `AI推定コストが完全なcoverageでwarning閾値未満へ復旧しました: ${estimateText}; ${thresholdText}; ${coverageText}`;
    db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
      .run(detail, timestamp, timestamp, code, scope);
    try {
      notified = await send("recovery", detail);
      if (notified) db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?").run(now(), code, scope);
    } catch (error) {
      notificationFailure = true;
      console.error(`[ai-cost-alert] recovery notification failed: ${safe(error instanceof Error ? error.message : error)}`);
    }
  }

  return { enabled: true, exceeded: false, observable: true, notified, notificationFailure };
}
