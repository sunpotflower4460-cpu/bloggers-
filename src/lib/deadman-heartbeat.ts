import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type DB = InstanceType<typeof Database>;
export type DeadmanKind = "worker" | "backup";

export interface DeadmanHeartbeatState {
  kind: DeadmanKind;
  configured: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastStatus: number | null;
}

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenDeadmanDb?: DB };
const db = globalDb.__blogGardenDeadmanDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenDeadmanDb = db;
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS external_deadman_heartbeats (
  kind TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER
);
`);

function envName(kind: DeadmanKind): string {
  return kind === "worker" ? "DEADMAN_WORKER_URL" : "DEADMAN_BACKUP_URL";
}

function configuredUrl(kind: DeadmanKind): URL | null {
  const raw = process.env[envName(kind)]?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.username || url.password) throw new Error(`${envName(kind)} must not contain embedded credentials`);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new Error(`${envName(kind)} must use HTTPS in production`);
  }
  return url;
}

function safeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/https?:\/\/[^\s]+/gi, "[deadman-url]")
    .replace(/(token|key|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function markSuccess(kind: DeadmanKind, status: number): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO external_deadman_heartbeats
    (kind,last_success_at,last_attempt_at,last_failure_at,consecutive_failures,last_status)
    VALUES (?,?,?,NULL,0,?)
    ON CONFLICT(kind) DO UPDATE SET
      last_success_at=excluded.last_success_at,
      last_attempt_at=excluded.last_attempt_at,
      consecutive_failures=0,
      last_status=excluded.last_status`)
    .run(kind, now, now, status);
}

function markFailure(kind: DeadmanKind, status: number | null): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO external_deadman_heartbeats
    (kind,last_success_at,last_attempt_at,last_failure_at,consecutive_failures,last_status)
    VALUES (?,NULL,?,?,1,?)
    ON CONFLICT(kind) DO UPDATE SET
      last_attempt_at=excluded.last_attempt_at,
      last_failure_at=excluded.last_failure_at,
      consecutive_failures=external_deadman_heartbeats.consecutive_failures+1,
      last_status=excluded.last_status`)
    .run(kind, now, now, status);
}

export async function pingDeadman(kind: DeadmanKind): Promise<{ configured: boolean; delivered: boolean }> {
  let url: URL | null;
  try {
    url = configuredUrl(kind);
  } catch (error) {
    markFailure(kind, null);
    console.warn(`[deadman] ${kind} configuration rejected: ${safeError(error)}`);
    return { configured: true, delivered: false };
  }
  if (!url) return { configured: false, delivered: false };

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "user-agent": "blog-garden-deadman/1" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      markFailure(kind, response.status);
      console.warn(`[deadman] ${kind} heartbeat failed with HTTP ${response.status}`);
      return { configured: true, delivered: false };
    }
    markSuccess(kind, response.status);
    return { configured: true, delivered: true };
  } catch (error) {
    markFailure(kind, null);
    console.warn(`[deadman] ${kind} heartbeat failed: ${safeError(error)}`);
    return { configured: true, delivered: false };
  }
}

export function deadmanHeartbeatState(kind: DeadmanKind): DeadmanHeartbeatState {
  let configured = false;
  try {
    configured = Boolean(configuredUrl(kind));
  } catch {
    configured = true;
  }
  const row = db.prepare(`SELECT last_success_at,last_attempt_at,last_failure_at,consecutive_failures,last_status
    FROM external_deadman_heartbeats WHERE kind=?`).get(kind) as {
      last_success_at: string | null;
      last_attempt_at: string | null;
      last_failure_at: string | null;
      consecutive_failures: number;
      last_status: number | null;
    } | undefined;
  return {
    kind,
    configured,
    lastSuccessAt: row?.last_success_at ?? null,
    lastAttemptAt: row?.last_attempt_at ?? null,
    lastFailureAt: row?.last_failure_at ?? null,
    consecutiveFailures: Number(row?.consecutive_failures || 0),
    lastStatus: row?.last_status ?? null,
  };
}
