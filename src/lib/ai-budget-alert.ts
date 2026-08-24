import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aiBudgetStatus } from "./ai-budget";

type DB = InstanceType<typeof Database>;
type AlertKind = "critical" | "recovery";

interface IncidentRow {
  status: "open" | "closed";
  detail: string;
  last_notified_at: string | null;
}

const code = "ai-budget-exhausted";
const scope = "system";
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

async function send(kind: AlertKind, detail: string): Promise<boolean> {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return false;
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("ALERT_WEBHOOK_URL must use HTTPS in production");
  }
  const marker = kind === "critical" ? "CRITICAL" : "RECOVERY";
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

export async function reconcileAiBudgetIncident(): Promise<{ exhausted: boolean; notified: boolean; notificationFailure: boolean }> {
  const budget = aiBudgetStatus();
  const existing = db.prepare("SELECT status,detail,last_notified_at FROM operational_incidents WHERE code=? AND scope=?")
    .get(code, scope) as IncidentRow | undefined;
  const timestamp = now();
  let notified = false;
  let notificationFailure = false;

  if (budget.exhausted) {
    const detail = `AI日次予算に到達: calls ${budget.calls}/${budget.callLimit}, tokens ${budget.totalTokens}/${budget.tokenLimit}, day=${budget.dayKey} (${budget.timezone})`;
    if (!existing) {
      db.prepare(`INSERT INTO operational_incidents
        (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
        VALUES (?,?, 'open','critical',?,?,?,NULL,NULL)`)
        .run(code, scope, detail, timestamp, timestamp);
    } else {
      db.prepare(`UPDATE operational_incidents SET status='open',severity='critical',detail=?,updated_at=?,resolved_at=NULL WHERE code=? AND scope=?`)
        .run(detail, timestamp, code, scope);
    }

    const shouldNotify = !existing || existing.status === "closed" || hoursSince(existing.last_notified_at) >= 24;
    if (shouldNotify) {
      try {
        if (await send("critical", detail)) {
          notified = true;
          db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?").run(now(), code, scope);
        }
      } catch (error) {
        notificationFailure = true;
        console.error(`[ai-budget-alert] notification failed: ${safe(error instanceof Error ? error.message : error)}`);
      }
    }
    return { exhausted: true, notified, notificationFailure };
  }

  if (existing?.status === "open") {
    const detail = `AI日次予算が復旧: calls ${budget.calls}/${budget.callLimit}, tokens ${budget.totalTokens}/${budget.tokenLimit}, day=${budget.dayKey} (${budget.timezone})`;
    db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
      .run(detail, timestamp, timestamp, code, scope);
    try {
      notified = await send("recovery", detail);
      if (notified) db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?").run(now(), code, scope);
    } catch (error) {
      notificationFailure = true;
      console.error(`[ai-budget-alert] recovery notification failed: ${safe(error instanceof Error ? error.message : error)}`);
    }
  }

  return { exhausted: false, notified, notificationFailure };
}
