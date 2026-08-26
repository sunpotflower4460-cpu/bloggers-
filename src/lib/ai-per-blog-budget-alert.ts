import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aiPerBlogBudgetStatus, type AiPerBlogBudgetScopeStatus } from "./ai-budget";

type DB = InstanceType<typeof Database>;
type NotificationKind = "warning" | "recovery";

interface IncidentRow {
  scope: string;
  status: "open" | "closed";
  detail: string;
  last_notified_at: string | null;
}

const code = "ai-per-blog-budget-exhausted";
const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenAiPerBlogBudgetAlertDb?: DB };
const db = globalDb.__blogGardenAiPerBlogBudgetAlertDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiPerBlogBudgetAlertDb = db;
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
    .replace(/([?&](?:key|token|secret|password|signature)=)[^&\s]+/gi, "$1[redacted]")
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

async function send(kind: NotificationKind, scope: string, detail: string): Promise<boolean> {
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
  if (!response.ok) throw new Error(`Per-blog AI budget webhook failed with HTTP ${response.status}`);
  return true;
}

function openRows(): IncidentRow[] {
  return db.prepare("SELECT scope,status,detail,last_notified_at FROM operational_incidents WHERE code=? AND status='open'")
    .all(code) as IncidentRow[];
}

function detailFor(row: AiPerBlogBudgetScopeStatus, dayKey: string, timezone: string): string {
  return `${row.scopeLabel} がブログ別AI日次call上限に到達: ${row.calls}/${row.limit} calls, day=${dayKey} (${timezone})。このブログの次のAI outbound callは上限が解消するまで送信されません。`;
}

export async function reconcileAiPerBlogBudgetIncidents(): Promise<{
  configured: boolean;
  exhaustedScopes: number;
  notifications: number;
  notificationFailures: number;
  configError: string | null;
}> {
  let budget;
  try {
    budget = aiPerBlogBudgetStatus();
  } catch (error) {
    // A malformed optional cap must not take down unrelated operational checks.
    // Preserve existing incidents rather than falsely announcing recovery.
    return {
      configured: true,
      exhaustedScopes: openRows().length,
      notifications: 0,
      notificationFailures: 0,
      configError: safe(error instanceof Error ? error.message : error),
    };
  }

  const timestamp = now();
  const existingOpen = new Map(openRows().map((row) => [row.scope, row]));
  let notifications = 0;
  let notificationFailures = 0;

  if (!budget.configured || budget.limit === null) {
    for (const incident of existingOpen.values()) {
      const detail = `ブログ別AI日次call上限の監視が運用者により無効化されました。これはAI使用量が減少したことを確認した復旧ではありません。直前の状態: ${safe(incident.detail)}`;
      db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
        .run(detail, timestamp, timestamp, code, incident.scope);
      try {
        if (await send("recovery", incident.scope, detail)) {
          notifications += 1;
          db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?")
            .run(now(), code, incident.scope);
        }
      } catch (error) {
        notificationFailures += 1;
        console.error(`[ai-per-blog-budget-alert] disable recovery notification failed: ${safe(error instanceof Error ? error.message : error)}`);
      }
    }
    return { configured: false, exhaustedScopes: 0, notifications, notificationFailures, configError: null };
  }

  const current = new Map(budget.scopes.map((row) => [row.scopeKey, row]));
  const exhausted = budget.scopes.filter((row) => row.exhausted);

  for (const row of exhausted) {
    const detail = detailFor(row, budget.dayKey, budget.timezone);
    const existing = existingOpen.get(row.scopeKey);
    if (!existing) {
      db.prepare(`INSERT INTO operational_incidents
        (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
        VALUES (?,?,'open','warning',?,?,?,NULL,NULL)`)
        .run(code, row.scopeKey, detail, timestamp, timestamp);
    } else {
      db.prepare(`UPDATE operational_incidents SET status='open',severity='warning',detail=?,updated_at=?,resolved_at=NULL WHERE code=? AND scope=?`)
        .run(detail, timestamp, code, row.scopeKey);
    }

    const shouldNotify = !existing || hoursSince(existing.last_notified_at) >= 48;
    if (shouldNotify) {
      try {
        if (await send("warning", row.scopeKey, detail)) {
          notifications += 1;
          db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?")
            .run(now(), code, row.scopeKey);
        }
      } catch (error) {
        notificationFailures += 1;
        console.error(`[ai-per-blog-budget-alert] warning notification failed: ${safe(error instanceof Error ? error.message : error)}`);
      }
    }
  }

  for (const incident of existingOpen.values()) {
    const row = current.get(incident.scope);
    if (row?.exhausted) continue;
    const reason = row
      ? `${row.scopeLabel} のブログ別AI call上限状態が解消: ${row.calls}/${row.limit} calls, day=${budget.dayKey} (${budget.timezone})。日付切替または上限変更の可能性があります。`
      : `ブログ別AI call上限状態が解消しました。現在のbudget day=${budget.dayKey} (${budget.timezone})では、このscopeに上限到達したcall履歴はありません。`;
    db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
      .run(reason, timestamp, timestamp, code, incident.scope);
    try {
      if (await send("recovery", incident.scope, reason)) {
        notifications += 1;
        db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?")
          .run(now(), code, incident.scope);
      }
    } catch (error) {
      notificationFailures += 1;
      console.error(`[ai-per-blog-budget-alert] recovery notification failed: ${safe(error instanceof Error ? error.message : error)}`);
    }
  }

  return {
    configured: true,
    exhaustedScopes: exhausted.length,
    notifications,
    notificationFailures,
    configError: null,
  };
}
