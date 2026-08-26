import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aiPerBlogBudgetStatus, type AiPerBlogBudgetScopeStatus } from "./ai-budget";

type DB = InstanceType<typeof Database>;
type NotificationKind = "warning" | "recovery";

interface IncidentRow {
  code: string;
  scope: string;
  status: "open" | "closed";
  detail: string;
  last_notified_at: string | null;
}

const exhaustedCode = "ai-per-blog-budget-exhausted";
const nearLimitCode = "ai-per-blog-budget-near-limit";
const warningUtilization = 0.8;
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

async function send(kind: NotificationKind, code: string, scope: string, detail: string): Promise<boolean> {
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

function incidentRows(code: string): IncidentRow[] {
  return db.prepare("SELECT code,scope,status,detail,last_notified_at FROM operational_incidents WHERE code=?")
    .all(code) as IncidentRow[];
}

function sourceLabel(row: AiPerBlogBudgetScopeStatus): string {
  return row.limitSource === "override" ? "個別override" : "共通上限";
}

function exhaustedDetail(row: AiPerBlogBudgetScopeStatus, dayKey: string, timezone: string): string {
  return `${row.scopeLabel} がブログ別AI日次call上限に到達: ${row.calls}/${row.limit} calls (${sourceLabel(row)}), day=${dayKey} (${timezone})。このブログの次のAI outbound callは上限が解消するまで送信されません。`;
}

function nearLimitDetail(row: AiPerBlogBudgetScopeStatus, dayKey: string, timezone: string): string {
  return `${row.scopeLabel} のブログ別AI日次call上限が80%以上: ${(row.utilization * 100).toFixed(1)}%, ${row.calls}/${row.limit} calls (${sourceLabel(row)}), day=${dayKey} (${timezone})。まだ保護停止ではありませんが、次のAI処理で上限へ到達する可能性があります。`;
}

function openIncident(code: string, scope: string, detail: string, timestamp: string, existing: IncidentRow | undefined): void {
  if (!existing) {
    db.prepare(`INSERT INTO operational_incidents
      (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
      VALUES (?,?,'open','warning',?,?,?,NULL,NULL)`)
      .run(code, scope, detail, timestamp, timestamp);
    return;
  }
  db.prepare(`UPDATE operational_incidents SET status='open',severity='warning',detail=?,updated_at=?,resolved_at=NULL WHERE code=? AND scope=?`)
    .run(detail, timestamp, code, scope);
}

function closeSilently(code: string, scope: string, detail: string, timestamp: string): void {
  db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=?
    WHERE code=? AND scope=? AND status='open'`).run(detail, timestamp, timestamp, code, scope);
}

async function notify(
  kind: NotificationKind,
  code: string,
  scope: string,
  detail: string,
): Promise<{ sent: boolean; failed: boolean }> {
  try {
    const sent = await send(kind, code, scope, detail);
    if (sent) {
      db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?")
        .run(now(), code, scope);
    }
    return { sent, failed: false };
  } catch (error) {
    console.error(`[ai-per-blog-budget-alert] notification failed: ${safe(error instanceof Error ? error.message : error)}`);
    return { sent: false, failed: true };
  }
}

async function recoverIncident(
  incident: IncidentRow,
  detail: string,
  timestamp: string,
): Promise<{ sent: boolean; failed: boolean }> {
  db.prepare(`UPDATE operational_incidents SET status='closed',detail=?,updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
    .run(detail, timestamp, timestamp, incident.code, incident.scope);
  return notify("recovery", incident.code, incident.scope, detail);
}

export async function reconcileAiPerBlogBudgetIncidents(): Promise<{
  configured: boolean;
  exhaustedScopes: number;
  warningScopes: number;
  notifications: number;
  notificationFailures: number;
  configError: string | null;
}> {
  let budget;
  const exhaustedExisting = incidentRows(exhaustedCode);
  const nearExisting = incidentRows(nearLimitCode);
  const exhaustedByScope = new Map(exhaustedExisting.map((row) => [row.scope, row]));
  const nearByScope = new Map(nearExisting.map((row) => [row.scope, row]));
  const exhaustedOpen = exhaustedExisting.filter((row) => row.status === "open");
  const nearOpen = nearExisting.filter((row) => row.status === "open");

  try {
    budget = aiPerBlogBudgetStatus();
  } catch (error) {
    // Invalid optional cap/override is not a recovery signal. Preserve both
    // near-limit and exhausted OPEN incidents until a valid snapshot exists.
    return {
      configured: true,
      exhaustedScopes: exhaustedOpen.length,
      warningScopes: nearOpen.length,
      notifications: 0,
      notificationFailures: 0,
      configError: safe(error instanceof Error ? error.message : error),
    };
  }

  const timestamp = now();
  let notifications = 0;
  let notificationFailures = 0;

  if (!budget.configured) {
    for (const incident of [...exhaustedOpen, ...nearOpen]) {
      const detail = `ブログ別AI日次call上限の監視が運用者により無効化されました。これはAI使用量が減少したことを確認した復旧ではありません。直前の状態: ${safe(incident.detail)}`;
      const result = await recoverIncident(incident, detail, timestamp);
      if (result.sent) notifications += 1;
      if (result.failed) notificationFailures += 1;
    }
    return {
      configured: false,
      exhaustedScopes: 0,
      warningScopes: 0,
      notifications,
      notificationFailures,
      configError: null,
    };
  }

  const current = new Map(budget.scopes.map((row) => [row.scopeKey, row]));
  const exhausted = budget.scopes.filter((row) => row.exhausted);
  const nearLimit = budget.scopes.filter((row) => !row.exhausted && row.utilization >= warningUtilization);
  const exhaustedScopes = new Set(exhausted.map((row) => row.scopeKey));
  const nearScopes = new Set(nearLimit.map((row) => row.scopeKey));

  for (const row of exhausted) {
    // This is an escalation, not a recovery. Close the advisory near-limit row
    // silently before opening/reopening the existing F-039 protection incident.
    closeSilently(
      nearLimitCode,
      row.scopeKey,
      `${row.scopeLabel} のnear-limit warningを終了: 100%に到達したため${exhaustedCode}へ引き継ぎました`,
      timestamp,
    );

    const detail = exhaustedDetail(row, budget.dayKey, budget.timezone);
    const existing = exhaustedByScope.get(row.scopeKey);
    openIncident(exhaustedCode, row.scopeKey, detail, timestamp, existing);
    const shouldNotify = !existing || existing.status === "closed" || hoursSince(existing.last_notified_at) >= 48;
    if (shouldNotify) {
      const result = await notify("warning", exhaustedCode, row.scopeKey, detail);
      if (result.sent) notifications += 1;
      if (result.failed) notificationFailures += 1;
    }
  }

  for (const row of nearLimit) {
    // If a limit was raised from exhausted to 80-99%, this is a downgrade to an
    // advisory warning, not a full recovery. Do not emit a false RECOVERY.
    closeSilently(
      exhaustedCode,
      row.scopeKey,
      `${row.scopeLabel} のhard-cap保護停止は解除されましたが利用率が80%以上のため${nearLimitCode}へ移行しました`,
      timestamp,
    );

    const detail = nearLimitDetail(row, budget.dayKey, budget.timezone);
    const existing = nearByScope.get(row.scopeKey);
    openIncident(nearLimitCode, row.scopeKey, detail, timestamp, existing);
    const shouldNotify = !existing || existing.status === "closed" || hoursSince(existing.last_notified_at) >= 48;
    if (shouldNotify) {
      const result = await notify("warning", nearLimitCode, row.scopeKey, detail);
      if (result.sent) notifications += 1;
      if (result.failed) notificationFailures += 1;
    }
  }

  for (const incident of exhaustedOpen) {
    if (exhaustedScopes.has(incident.scope) || nearScopes.has(incident.scope)) continue;
    const row = current.get(incident.scope);
    const detail = row
      ? `${row.scopeLabel} のブログ別AI call上限状態が解消: ${row.calls}/${row.limit} calls (${sourceLabel(row)}), day=${budget.dayKey} (${budget.timezone})。利用率は80%未満です。`
      : `ブログ別AI call上限状態が解消しました。現在のbudget day=${budget.dayKey} (${budget.timezone})では、このscopeに有効な上限状態がありません。共通上限または個別overrideの変更・解除の可能性があります。`;
    const result = await recoverIncident(incident, detail, timestamp);
    if (result.sent) notifications += 1;
    if (result.failed) notificationFailures += 1;
  }

  for (const incident of nearOpen) {
    if (exhaustedScopes.has(incident.scope) || nearScopes.has(incident.scope)) continue;
    const row = current.get(incident.scope);
    const detail = row
      ? `${row.scopeLabel} のブログ別AI call上限warningが復旧: ${row.calls}/${row.limit} calls (${sourceLabel(row)}), utilization ${(row.utilization * 100).toFixed(1)}%, day=${budget.dayKey} (${budget.timezone})。`
      : `ブログ別AI call上限warningが復旧しました。現在のbudget day=${budget.dayKey} (${budget.timezone})では、このscopeに有効な上限状態がありません。`;
    const result = await recoverIncident(incident, detail, timestamp);
    if (result.sent) notifications += 1;
    if (result.failed) notificationFailures += 1;
  }

  return {
    configured: true,
    exhaustedScopes: exhausted.length,
    warningScopes: nearLimit.length,
    notifications,
    notificationFailures,
    configError: null,
  };
}
