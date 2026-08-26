import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aiBudgetStatus } from "./ai-budget";

type DB = InstanceType<typeof Database>;
type AlertKind = "warning" | "critical" | "recovery";

interface IncidentRow {
  status: "open" | "closed";
  detail: string;
  last_notified_at: string | null;
}

const exhaustedCode = "ai-budget-exhausted";
const warningCode = "ai-budget-near-limit";
const scope = "system";
const warningUtilization = 0.8;
const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenAiBudgetAlertDb?: DB };
const db = globalDb.__blogGardenAiBudgetAlertDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiBudgetAlertDb = db;
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
    .slice(0, 800);
}

function webhookKind(url: URL): "slack" | "discord" | "generic" {
  const configured = (process.env.ALERT_WEBHOOK_KIND || "auto").toLowerCase();
  if (configured === "slack" || configured === "discord" || configured === "generic") return configured;
  if (url.hostname === "hooks.slack.com") return "slack";
  if (url.hostname === "discord.com" || url.hostname === "discordapp.com") return "discord";
  return "generic";
}

async function send(kind: AlertKind, code: string, detail: string): Promise<boolean> {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return false;
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("ALERT_WEBHOOK_URL must use HTTPS in production");
  }
  const marker = kind === "critical" ? "CRITICAL" : kind === "warning" ? "WARNING" : "RECOVERY";
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
  if (!response.ok) throw new Error(`AI budget webhook failed with HTTP ${response.status}`);
  return true;
}

function incident(code: string): IncidentRow | undefined {
  return db.prepare("SELECT status,detail,last_notified_at FROM operational_incidents WHERE code=? AND scope=?")
    .get(code, scope) as IncidentRow | undefined;
}

function upsertOpen(code: string, severity: "warning" | "critical", detail: string, timestamp: string): IncidentRow | undefined {
  const existing = incident(code);
  if (!existing) {
    db.prepare(`INSERT INTO operational_incidents
      (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
      VALUES (?,?, 'open',?,?,?, ?,NULL,NULL)`)
      .run(code, scope, severity, detail, timestamp, timestamp);
  } else {
    db.prepare(`UPDATE operational_incidents SET status='open',severity=?,detail=?,updated_at=?,resolved_at=NULL WHERE code=? AND scope=?`)
      .run(severity, detail, timestamp, code, scope);
  }
  return existing;
}

function closeSilently(code: string, detail: string, timestamp: string): boolean {
  const existing = incident(code);
  if (!existing || existing.status !== "open") return false;
  db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
    .run(detail, timestamp, timestamp, code, scope);
  return true;
}

async function notify(kind: AlertKind, code: string, detail: string): Promise<{ sent: boolean; failed: boolean }> {
  try {
    const sent = await send(kind, code, detail);
    if (sent) db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?").run(now(), code, scope);
    return { sent, failed: false };
  } catch (error) {
    console.error(`[ai-budget-alert] notification failed: ${safe(error instanceof Error ? error.message : error)}`);
    return { sent: false, failed: true };
  }
}

async function recover(code: string, detail: string, timestamp: string): Promise<{ sent: boolean; failed: boolean }> {
  const existing = incident(code);
  if (!existing || existing.status !== "open") return { sent: false, failed: false };
  db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
    .run(detail, timestamp, timestamp, code, scope);
  return notify("recovery", code, detail);
}

export async function reconcileAiBudgetIncident(): Promise<{
  exhausted: boolean;
  warning: boolean;
  notified: boolean;
  notificationFailure: boolean;
}> {
  const budget = aiBudgetStatus();
  const timestamp = now();
  const nearLimit = !budget.exhausted && budget.utilization >= warningUtilization;
  let notified = false;
  let notificationFailure = false;

  if (budget.exhausted) {
    closeSilently(
      warningCode,
      `AI日次予算warningを終了: hard capに到達したため${exhaustedCode} CRITICALへ引き継ぎました`,
      timestamp,
    );

    const detail = `AI日次予算に到達: calls ${budget.calls}/${budget.callLimit}, tokens ${budget.totalTokens}/${budget.tokenLimit}, day=${budget.dayKey} (${budget.timezone})`;
    const existing = upsertOpen(exhaustedCode, "critical", detail, timestamp);
    const shouldNotify = !existing || existing.status === "closed" || hoursSince(existing.last_notified_at) >= 24;
    if (shouldNotify) {
      const result = await notify("critical", exhaustedCode, detail);
      notified ||= result.sent;
      notificationFailure ||= result.failed;
    }
    return { exhausted: true, warning: false, notified, notificationFailure };
  }

  if (nearLimit) {
    closeSilently(
      exhaustedCode,
      `AI日次予算hard capは解除されましたが利用率が80%以上のため${warningCode} WARNINGへ移行しました`,
      timestamp,
    );

    const percent = (budget.utilization * 100).toFixed(1);
    const detail = `AI日次予算が80%以上: utilization ${percent}%, calls ${budget.calls}/${budget.callLimit}, tokens ${budget.totalTokens}/${budget.tokenLimit}, day=${budget.dayKey} (${budget.timezone})`;
    const existing = upsertOpen(warningCode, "warning", detail, timestamp);
    const shouldNotify = !existing || existing.status === "closed" || hoursSince(existing.last_notified_at) >= 48;
    if (shouldNotify) {
      const result = await notify("warning", warningCode, detail);
      notified ||= result.sent;
      notificationFailure ||= result.failed;
    }
    return { exhausted: false, warning: true, notified, notificationFailure };
  }

  const warningRecovery = await recover(
    warningCode,
    `AI日次予算warningが復旧: utilization ${(budget.utilization * 100).toFixed(1)}%, calls ${budget.calls}/${budget.callLimit}, tokens ${budget.totalTokens}/${budget.tokenLimit}, day=${budget.dayKey} (${budget.timezone})`,
    timestamp,
  );
  notified ||= warningRecovery.sent;
  notificationFailure ||= warningRecovery.failed;

  const exhaustedRecovery = await recover(
    exhaustedCode,
    `AI日次予算が復旧: calls ${budget.calls}/${budget.callLimit}, tokens ${budget.totalTokens}/${budget.tokenLimit}, day=${budget.dayKey} (${budget.timezone})`,
    timestamp,
  );
  notified ||= exhaustedRecovery.sent;
  notificationFailure ||= exhaustedRecovery.failed;

  return { exhausted: false, warning: false, notified, notificationFailure };
}
