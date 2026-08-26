import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { externalHeartbeatStatus, type ExternalHeartbeatKind } from "./external-heartbeat";

type DB = InstanceType<typeof Database>;
type Severity = "warning" | "critical";
type AlertKind = Severity | "recovery";

interface IncidentRow {
  status: "open" | "closed";
  severity: Severity;
  detail: string;
  last_notified_at: string | null;
}

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenExternalHeartbeatAlertDb?: DB };
const db = globalDb.__blogGardenExternalHeartbeatAlertDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenExternalHeartbeatAlertDb = db;
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
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
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
  const text = `[Blog Garden][${marker}] system / ${code}\n${safe(detail)}`;
  const target = webhookKind(url);
  const body = target === "slack"
    ? { text }
    : target === "discord"
      ? { content: text.slice(0, 1900) }
      : { text, severity: kind, code, scope: "system", detail: safe(detail), at: now() };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`External heartbeat alert webhook failed with HTTP ${response.status}`);
  return true;
}

function signalFor(kind: ExternalHeartbeatKind): { active: boolean; severity: Severity; detail: string } {
  const status = externalHeartbeatStatus(kind);
  const label = kind === "worker" ? "worker" : "backup";
  if (!status.configured) return { active: false, severity: "warning", detail: `${label} dead-man heartbeat disabled` };

  const failedAfterSuccess = Boolean(
    status.lastFailureAt
      && (!status.lastSuccessAt || new Date(status.lastFailureAt).getTime() > new Date(status.lastSuccessAt).getTime()),
  );
  if (failedAfterSuccess) {
    return {
      active: true,
      severity: "warning",
      detail: `${label} dead-man heartbeat delivery failed: ${safe(status.lastFailureDetail || "unknown failure")}`,
    };
  }

  // A freshly configured hook may not have had its first scheduled run yet. Do not
  // alarm until a success/failure has actually been observed.
  if (!status.lastSuccessAt) {
    return { active: false, severity: "warning", detail: `${label} dead-man heartbeat has not run yet` };
  }

  const age = hoursSince(status.lastSuccessAt);
  const warningHours = kind === "worker" ? 3 : 36;
  const criticalHours = kind === "worker" ? 6 : 72;
  if (age > warningHours) {
    return {
      active: true,
      severity: age > criticalHours ? "critical" : "warning",
      detail: `${label} dead-man heartbeat last succeeded ${age.toFixed(1)} hours ago`,
    };
  }
  return { active: false, severity: "warning", detail: `${label} dead-man heartbeat healthy` };
}

async function reconcile(kind: ExternalHeartbeatKind): Promise<{ open: boolean; notified: boolean; notificationFailure: boolean }> {
  const code = `external-${kind}-heartbeat`;
  const signal = signalFor(kind);
  const existing = db.prepare("SELECT status,severity,detail,last_notified_at FROM operational_incidents WHERE code=? AND scope='system'")
    .get(code) as IncidentRow | undefined;
  const timestamp = now();
  let notified = false;
  let notificationFailure = false;

  if (signal.active) {
    if (!existing) {
      db.prepare(`INSERT INTO operational_incidents
        (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
        VALUES (?, 'system','open',?,?,?, ?,NULL,NULL)`)
        .run(code, signal.severity, signal.detail, timestamp, timestamp);
    } else {
      db.prepare(`UPDATE operational_incidents SET status='open',severity=?,detail=?,updated_at=?,resolved_at=NULL
        WHERE code=? AND scope='system'`)
        .run(signal.severity, signal.detail, timestamp, code);
    }
    const escalated = existing?.severity === "warning" && signal.severity === "critical";
    const reminderHours = signal.severity === "critical" ? 24 : 48;
    const shouldNotify = !existing || existing.status === "closed" || escalated || hoursSince(existing.last_notified_at) >= reminderHours;
    if (shouldNotify) {
      try {
        if (await send(signal.severity, code, signal.detail)) {
          notified = true;
          db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope='system'")
            .run(now(), code);
        }
      } catch (error) {
        notificationFailure = true;
        console.error(`[external-heartbeat-alert] notification failed for ${code}: ${safe(error instanceof Error ? error.message : error)}`);
      }
    }
    return { open: true, notified, notificationFailure };
  }

  if (existing?.status === "open") {
    const detail = `${kind} dead-man heartbeat recovered. Previous incident: ${safe(existing.detail)}`;
    db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=?
      WHERE code=? AND scope='system'`)
      .run(detail, timestamp, timestamp, code);
    try {
      notified = await send("recovery", code, detail);
      if (notified) {
        db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope='system'")
          .run(now(), code);
      }
    } catch (error) {
      notificationFailure = true;
      console.error(`[external-heartbeat-alert] recovery notification failed for ${code}: ${safe(error instanceof Error ? error.message : error)}`);
    }
  }
  return { open: false, notified, notificationFailure };
}

export async function reconcileExternalHeartbeatIncidents(): Promise<{
  open: number;
  notified: number;
  notificationFailures: number;
}> {
  const results = await Promise.all([reconcile("worker"), reconcile("backup")]);
  return {
    open: results.filter((item) => item.open).length,
    notified: results.filter((item) => item.notified).length,
    notificationFailures: results.filter((item) => item.notificationFailure).length,
  };
}
