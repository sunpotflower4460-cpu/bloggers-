import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aiRoutingStatus, type AiAttemptOutcome } from "./ai-routing";
import { listBlogs } from "./db";

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
const globalDb = globalThis as typeof globalThis & { __blogGardenAiRoutingAlertDb?: DB };
const db = globalDb.__blogGardenAiRoutingAlertDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiRoutingAlertDb = db;
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
    .replace(/https?:\/\/[^\s]+/gi, (candidate) => {
      try {
        const parsed = new URL(candidate);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url]";
      }
    })
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
  if (!response.ok) throw new Error(`AI routing webhook failed with HTTP ${response.status}`);
  return true;
}

async function reconcileOne(input: {
  code: string;
  active: boolean;
  severity: Severity;
  detail: string;
}): Promise<{ open: boolean; notified: boolean; notificationFailure: boolean }> {
  const existing = db.prepare("SELECT status,severity,detail,last_notified_at FROM operational_incidents WHERE code=? AND scope='system'")
    .get(input.code) as IncidentRow | undefined;
  const timestamp = now();
  let notified = false;
  let notificationFailure = false;

  if (input.active) {
    if (!existing) {
      db.prepare(`INSERT INTO operational_incidents
        (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
        VALUES (?, 'system','open',?,?,?, ?,NULL,NULL)`)
        .run(input.code, input.severity, input.detail, timestamp, timestamp);
    } else {
      db.prepare(`UPDATE operational_incidents SET status='open',severity=?,detail=?,updated_at=?,resolved_at=NULL
        WHERE code=? AND scope='system'`)
        .run(input.severity, input.detail, timestamp, input.code);
    }

    const escalated = existing?.severity === "warning" && input.severity === "critical";
    const reminderHours = input.severity === "critical" ? 24 : 48;
    const shouldNotify = !existing || existing.status === "closed" || escalated || hoursSince(existing.last_notified_at) >= reminderHours;
    if (shouldNotify) {
      try {
        if (await send(input.severity, input.code, input.detail)) {
          notified = true;
          db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope='system'")
            .run(now(), input.code);
        }
      } catch (error) {
        notificationFailure = true;
        console.error(`[ai-routing-alert] notification failed for ${input.code}: ${safe(error instanceof Error ? error.message : error)}`);
      }
    }
    return { open: true, notified, notificationFailure };
  }

  if (existing?.status === "open") {
    const detail = `AI routing recovered. Previous incident: ${safe(existing.detail)}`;
    db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=?
      WHERE code=? AND scope='system'`)
      .run(detail, timestamp, timestamp, input.code);
    try {
      notified = await send("recovery", input.code, detail);
      if (notified) {
        db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope='system'")
          .run(now(), input.code);
      }
    } catch (error) {
      notificationFailure = true;
      console.error(`[ai-routing-alert] recovery notification failed for ${input.code}: ${safe(error instanceof Error ? error.message : error)}`);
    }
  }
  return { open: false, notified, notificationFailure };
}

function recentEconomyAttempts(): Array<{ attempted_at: string; outcome: AiAttemptOutcome }> {
  return db.prepare(`SELECT attempted_at,outcome FROM ai_provider_attempts
    WHERE route='economy' ORDER BY id DESC LIMIT 3`).all() as Array<{ attempted_at: string; outcome: AiAttemptOutcome }>;
}

function economyDegraded(): boolean {
  const rows = recentEconomyAttempts();
  return rows.length === 3
    && rows.every((row) => row.outcome === "retryable_error" || row.outcome === "fatal_error")
    && Date.now() - new Date(rows[2].attempted_at).getTime() <= 6 * 3600000;
}

export async function reconcileAiRoutingIncidents(): Promise<{
  open: number;
  notified: number;
  notificationFailures: number;
}> {
  const hasActiveBlogs = listBlogs().some((blog) => blog.active);
  const routing = aiRoutingStatus();
  const configDetail = routing.configError || "AI routing configuration is valid";
  const configResult = await reconcileOne({
    code: "ai-routing-config-invalid",
    active: hasActiveBlogs && !routing.configured,
    severity: "critical",
    detail: configDetail,
  });

  const degradedSeverity: Severity = routing.fallbackConfigured && routing.fallbackCurrentlyHealthy ? "warning" : "critical";
  const degradedDetail = [
    `primary ${routing.primaryLabel}/${routing.primaryModel || "unknown"} has 3 consecutive retryable failures`,
    `24h primary retryable failures=${routing.primaryRetryableFailures24h}`,
    routing.fallbackConfigured
      ? `fallback ${routing.fallbackLabel}/${routing.fallbackModel}: successes=${routing.fallbackSuccesses24h}, failures=${routing.fallbackFailures24h}`
      : "fallback is not configured",
  ].join("; ");
  const degradedResult = await reconcileOne({
    code: "ai-primary-degraded",
    active: hasActiveBlogs && routing.configured && routing.primaryDegraded,
    severity: degradedSeverity,
    detail: degradedDetail,
  });

  const economyIsDegraded = routing.internalPolicy === "economy" && economyDegraded();
  const economyDetail = [
    `economy ${routing.economyLabel || "economy"}/${routing.economyModel || "unknown"} has 3 consecutive failed attempts within 6h`,
    `24h economy successes=${routing.economySuccesses24h}, failures=${routing.economyFailures24h}`,
    "internal work is recovering through the normal route, so repeated failures can add one extra AI call per logical request",
  ].join("; ");
  const economyResult = await reconcileOne({
    code: "ai-economy-degraded",
    active: hasActiveBlogs && routing.configured && economyIsDegraded,
    severity: "warning",
    detail: economyDetail,
  });

  const results = [configResult, degradedResult, economyResult];
  return {
    open: results.filter((item) => item.open).length,
    notified: results.filter((item) => item.notified).length,
    notificationFailures: results.filter((item) => item.notificationFailure).length,
  };
}
