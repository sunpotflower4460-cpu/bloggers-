import Database from "better-sqlite3";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconcileStalePreparedContentRevisions } from "./content-revision-monitor";
import { decryptJson } from "./crypto";
import { listBlogs } from "./db";
import { platformAdapter } from "./platforms";

type DB = InstanceType<typeof Database>;
type Severity = "warning" | "critical";
type NotificationKind = Severity | "recovery";

interface Signal {
  code: string;
  scope: string;
  severity: Severity;
  detail: string;
}

interface IncidentRow {
  code: string;
  scope: string;
  status: "open" | "closed";
  severity: Severity;
  detail: string;
  opened_at: string;
  updated_at: string;
  last_notified_at: string | null;
  resolved_at: string | null;
}

interface Notification {
  kind: NotificationKind;
  code: string;
  scope: string;
  detail: string;
}

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
const globalDb = globalThis as typeof globalThis & { __blogGardenOpsDb?: DB };
const db = globalDb.__blogGardenOpsDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenOpsDb = db;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS system_heartbeats (
  name TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS monitor_checks (
  check_key TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL
);
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
CREATE INDEX IF NOT EXISTS idx_operational_incidents_status ON operational_incidents(status, updated_at DESC);
`);

function isoNow(): string {
  return new Date().toISOString();
}

function hoursSince(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000);
}

function safeDetail(value: unknown): string {
  return String(value ?? "unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/([?&](?:key|token|secret|password|signature)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

export function heartbeat(name: string, meta: unknown = {}): void {
  db.prepare(`INSERT INTO system_heartbeats (name,last_seen,meta_json) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET last_seen=excluded.last_seen,meta_json=excluded.meta_json`)
    .run(name, isoNow(), JSON.stringify(meta ?? {}));
}

function heartbeatAt(name: string): string | null {
  const row = db.prepare("SELECT last_seen FROM system_heartbeats WHERE name=?").get(name) as { last_seen: string } | undefined;
  return row?.last_seen ?? null;
}

function markChecked(key: string): void {
  db.prepare(`INSERT INTO monitor_checks (check_key,checked_at) VALUES (?,?)
    ON CONFLICT(check_key) DO UPDATE SET checked_at=excluded.checked_at`).run(key, isoNow());
}

function checkDue(key: string, intervalHours: number): boolean {
  const row = db.prepare("SELECT checked_at FROM monitor_checks WHERE check_key=?").get(key) as { checked_at: string } | undefined;
  return !row || hoursSince(row.checked_at) >= intervalHours;
}

function backupDir(): string {
  return resolve(process.env.BACKUP_DIR || "./backups");
}

function latestBackup(): { ageHours: number; name: string } | null {
  const dir = backupDir();
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => /^blog-garden-\d{8}-\d{6}Z\.sqlite$/.test(name))
    .map((name) => ({ name, stat: statSync(join(dir, name)) }))
    .filter((entry) => entry.stat.isFile() && entry.stat.size > 0)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!files.length) return null;
  return { ageHours: Math.max(0, (Date.now() - files[0].stat.mtimeMs) / 3600000), name: files[0].name };
}

function offsiteMarker(): { ageHours: number } | null {
  const marker = join(backupDir(), ".offsite-last-success");
  if (!existsSync(marker)) return null;
  const stat = statSync(marker);
  if (!stat.isFile()) return null;
  return { ageHours: Math.max(0, (Date.now() - stat.mtimeMs) / 3600000) };
}

function consecutiveErrors(blogId: string, kind: string): { failed: boolean; detail: string } {
  const rows = db.prepare(`SELECT status,message,finished_at FROM run_logs
    WHERE blog_id=? AND kind=? ORDER BY finished_at DESC LIMIT 3`).all(blogId, kind) as Array<{ status: string; message: string; finished_at: string }>;
  if (rows.length < 3) return { failed: false, detail: "" };
  if (hoursSince(rows[2].finished_at) > 168) return { failed: false, detail: "" };
  const failed = rows.every((row) => row.status === "error");
  return { failed, detail: failed ? safeDetail(rows[0].message) : "" };
}

function keyOf(code: string, scope: string): string {
  return `${code}\u0000${scope}`;
}

function addSignal(map: Map<string, Signal>, signal: Signal): void {
  map.set(keyOf(signal.code, signal.scope), signal);
}

async function collectSignals(): Promise<{ signals: Map<string, Signal>; evaluated: Set<string> }> {
  const signals = new Map<string, Signal>();
  const evaluated = new Set<string>();
  const allBlogs = listBlogs();
  const blogs = allBlogs.filter((blog) => blog.active);

  const workerKey = keyOf("worker-stale", "system");
  evaluated.add(workerKey);
  if (blogs.length) {
    const last = heartbeatAt("worker");
    const oldestAge = Math.max(...blogs.map((blog) => hoursSince(blog.createdAt)));
    const age = last ? hoursSince(last) : oldestAge;
    if (age > 3) {
      addSignal(signals, {
        code: "worker-stale",
        scope: "system",
        severity: "critical",
        detail: last ? `worker heartbeatが${age.toFixed(1)}時間更新されていません` : "稼働ブログがありますがworker heartbeatがまだありません",
      });
    }
  }

  const backupKey = keyOf("backup-stale", "system");
  evaluated.add(backupKey);
  const backup = latestBackup();
  if (blogs.length) {
    const gardenAge = Math.max(...blogs.map((blog) => hoursSince(blog.createdAt)));
    if (!backup && gardenAge > 36) {
      addSignal(signals, {
        code: "backup-stale",
        scope: "system",
        severity: gardenAge > 72 ? "critical" : "warning",
        detail: "検証済みSQLiteバックアップが見つかりません",
      });
    } else if (backup && backup.ageHours > 36) {
      addSignal(signals, {
        code: "backup-stale",
        scope: "system",
        severity: backup.ageHours > 72 ? "critical" : "warning",
        detail: `最新バックアップ ${backup.name} が${backup.ageHours.toFixed(1)}時間前です`,
      });
    }
  }

  if (process.env.RESTIC_REPOSITORY?.trim()) {
    const offsiteKey = keyOf("offsite-backup-stale", "system");
    evaluated.add(offsiteKey);
    const marker = offsiteMarker();
    const gardenAge = blogs.length ? Math.max(...blogs.map((blog) => hoursSince(blog.createdAt))) : 0;
    if (!marker && gardenAge > 36) {
      addSignal(signals, {
        code: "offsite-backup-stale",
        scope: "system",
        severity: gardenAge > 72 ? "critical" : "warning",
        detail: "RESTIC_REPOSITORYは設定済みですが、成功したoffsite backup markerがありません",
      });
    } else if (marker && marker.ageHours > 36) {
      addSignal(signals, {
        code: "offsite-backup-stale",
        scope: "system",
        severity: marker.ageHours > 72 ? "critical" : "warning",
        detail: `offsite backupの最終成功が${marker.ageHours.toFixed(1)}時間前です`,
      });
    }
  }

  // F-052: a stale prepared row means the process died somewhere between the
  // durable pre-mutation snapshot and final local bookkeeping. Re-read the CMS
  // only; never retry or rollback remotely from the monitor.
  const existingRevisionIncidents = db.prepare(`SELECT scope FROM operational_incidents
    WHERE code='content-revision-uncertain' AND status='open'`).all() as Array<{ scope: string }>;
  for (const row of existingRevisionIncidents) evaluated.add(keyOf("content-revision-uncertain", row.scope));
  const revisionRecovery = await reconcileStalePreparedContentRevisions(15);
  for (const issue of revisionRecovery.uncertain) {
    const incidentKey = keyOf("content-revision-uncertain", issue.scope);
    evaluated.add(incidentKey);
    addSignal(signals, {
      code: "content-revision-uncertain",
      scope: issue.scope,
      severity: "critical",
      detail: issue.detail,
    });
  }

  for (const blog of blogs) {
    const definitions: Array<{ kind: string; code: string; severity: Severity; enabled: boolean }> = [
      { kind: "editorial", code: "editorial-failures", severity: "critical", enabled: true },
      { kind: "search-console", code: "search-console-failures", severity: "warning", enabled: Boolean(blog.searchConsoleSiteUrl) },
      { kind: "analytics", code: "ga4-failures", severity: "warning", enabled: Boolean(blog.ga4PropertyId) },
    ];
    for (const definition of definitions) {
      if (!definition.enabled) continue;
      const incidentKey = keyOf(definition.code, blog.name);
      evaluated.add(incidentKey);
      const failure = consecutiveErrors(blog.id, definition.kind);
      if (failure.failed) {
        addSignal(signals, {
          code: definition.code,
          scope: blog.name,
          severity: definition.severity,
          detail: `直近3回の${definition.kind}処理が連続失敗: ${failure.detail}`,
        });
      }
    }

    const platformKey = keyOf("platform-auth", blog.name);
    const checkKey = `platform-auth:${blog.id}`;
    if (checkDue(checkKey, 6)) {
      evaluated.add(platformKey);
      try {
        const credentials = decryptJson<unknown>(blog.credentialsCipher);
        await platformAdapter(blog.platform).validate(blog.siteUrl, credentials);
      } catch (error) {
        addSignal(signals, {
          code: "platform-auth",
          scope: blog.name,
          severity: "critical",
          detail: `${blog.platform} 投稿接続の確認に失敗: ${safeDetail(error instanceof Error ? error.message : error)}`,
        });
      } finally {
        markChecked(checkKey);
      }
    }
  }

  return { signals, evaluated };
}

function shouldRemind(row: IncidentRow): boolean {
  if (!row.last_notified_at) return true;
  const threshold = row.severity === "critical" ? 24 : 48;
  return hoursSince(row.last_notified_at) >= threshold;
}

function reconcile(signals: Map<string, Signal>, evaluated: Set<string>): Notification[] {
  const notifications: Notification[] = [];
  const now = isoNow();

  for (const evaluatedKey of evaluated) {
    const separator = evaluatedKey.indexOf("\u0000");
    const code = evaluatedKey.slice(0, separator);
    const scope = evaluatedKey.slice(separator + 1);
    const signal = signals.get(evaluatedKey);
    const existing = db.prepare("SELECT * FROM operational_incidents WHERE code=? AND scope=?").get(code, scope) as IncidentRow | undefined;

    if (signal) {
      if (!existing) {
        db.prepare(`INSERT INTO operational_incidents
          (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
          VALUES (?,?,?,?,?,?,?,NULL,NULL)`)
          .run(code, scope, "open", signal.severity, signal.detail, now, now);
        notifications.push({ kind: signal.severity, code, scope, detail: signal.detail });
        continue;
      }

      const reopened = existing.status === "closed";
      const escalated = existing.severity === "warning" && signal.severity === "critical";
      db.prepare(`UPDATE operational_incidents SET status='open',severity=?,detail=?,updated_at=?,resolved_at=NULL WHERE code=? AND scope=?`)
        .run(signal.severity, signal.detail, now, code, scope);
      if (reopened || escalated || shouldRemind(existing)) {
        notifications.push({ kind: signal.severity, code, scope, detail: signal.detail });
      }
      continue;
    }

    if (existing?.status === "open") {
      db.prepare(`UPDATE operational_incidents SET status='closed',updated_at=?,resolved_at=? WHERE code=? AND scope=?`)
        .run(now, now, code, scope);
      notifications.push({ kind: "recovery", code, scope, detail: `復旧しました。直前の障害: ${safeDetail(existing.detail)}` });
    }
  }

  return notifications;
}

function webhookKind(url: URL): "slack" | "discord" | "generic" {
  const configured = (process.env.ALERT_WEBHOOK_KIND || "auto").toLowerCase();
  if (configured === "slack" || configured === "discord" || configured === "generic") return configured;
  if (url.hostname === "hooks.slack.com") return "slack";
  if (url.hostname === "discord.com" || url.hostname === "discordapp.com") return "discord";
  return "generic";
}

async function sendNotification(notification: Notification): Promise<boolean> {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return false;
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("ALERT_WEBHOOK_URL must use HTTPS in production");
  }
  const marker = notification.kind === "critical" ? "CRITICAL" : notification.kind === "warning" ? "WARNING" : "RECOVERY";
  const text = `[Blog Garden][${marker}] ${notification.scope} / ${notification.code}\n${safeDetail(notification.detail)}`;
  const kind = webhookKind(url);
  const body = kind === "slack"
    ? { text }
    : kind === "discord"
      ? { content: text.slice(0, 1900) }
      : { text, severity: notification.kind, code: notification.code, scope: notification.scope, detail: safeDetail(notification.detail), at: isoNow() };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Alert webhook failed with HTTP ${response.status}`);
  return true;
}

function markNotified(notification: Notification): void {
  db.prepare("UPDATE operational_incidents SET last_notified_at=? WHERE code=? AND scope=?")
    .run(isoNow(), notification.code, notification.scope);
}

export async function runOperationalMonitor(): Promise<{
  openIncidents: number;
  notifications: number;
  notificationFailures: number;
  webhookConfigured: boolean;
}> {
  heartbeat("monitor", { phase: "start" });
  const { signals, evaluated } = await collectSignals();
  const notifications = reconcile(signals, evaluated);
  let sent = 0;
  let failures = 0;
  for (const notification of notifications) {
    try {
      const delivered = await sendNotification(notification);
      if (delivered) {
        sent += 1;
        markNotified(notification);
      }
    } catch (error) {
      failures += 1;
      console.error(`[monitor] notification failed for ${notification.code}/${notification.scope}: ${safeDetail(error instanceof Error ? error.message : error)}`);
    }
  }
  heartbeat("monitor", { phase: "complete", signals: signals.size, sent, failures });
  const row = db.prepare("SELECT COUNT(*) n FROM operational_incidents WHERE status='open'").get() as { n: number };
  return {
    openIncidents: Number(row.n || 0),
    notifications: sent,
    notificationFailures: failures,
    webhookConfigured: Boolean(process.env.ALERT_WEBHOOK_URL?.trim()),
  };
}

export function monitorStatus(): { lastSeen: string | null; openIncidents: number } {
  const row = db.prepare("SELECT COUNT(*) n FROM operational_incidents WHERE status='open'").get() as { n: number };
  return { lastSeen: heartbeatAt("monitor"), openIncidents: Number(row.n || 0) };
}
