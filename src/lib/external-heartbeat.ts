import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ExternalHeartbeatKind = "worker" | "backup";

export interface ExternalHeartbeatStatus {
  kind: ExternalHeartbeatKind;
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureDetail: string | null;
}

type DB = InstanceType<typeof Database>;
const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenExternalHeartbeatDb?: DB };
const db = globalDb.__blogGardenExternalHeartbeatDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenExternalHeartbeatDb = db;
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS external_heartbeat_deliveries (
  kind TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_failure_detail TEXT,
  updated_at TEXT NOT NULL
);
`);

function envName(kind: ExternalHeartbeatKind): string {
  return kind === "worker" ? "EXTERNAL_WORKER_HEARTBEAT_URL" : "EXTERNAL_BACKUP_HEARTBEAT_URL";
}

function configuredUrl(kind: ExternalHeartbeatKind): URL | null {
  const raw = process.env[envName(kind)]?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.username || url.password) throw new Error(`${envName(kind)} must not contain embedded credentials`);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`${envName(kind)} must use HTTPS in production`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${envName(kind)} must use HTTP or HTTPS`);
  }
  return url;
}

function safeDetail(value: unknown): string {
  return String(value ?? "external heartbeat failed")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[heartbeat-url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function recordSuccess(kind: ExternalHeartbeatKind): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO external_heartbeat_deliveries
    (kind,last_success_at,last_failure_at,last_failure_detail,updated_at)
    VALUES (?,?,NULL,NULL,?)
    ON CONFLICT(kind) DO UPDATE SET
      last_success_at=excluded.last_success_at,
      last_failure_at=NULL,
      last_failure_detail=NULL,
      updated_at=excluded.updated_at`)
    .run(kind, now, now);
}

function recordFailure(kind: ExternalHeartbeatKind, detail: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO external_heartbeat_deliveries
    (kind,last_success_at,last_failure_at,last_failure_detail,updated_at)
    VALUES (?,NULL,?,?,?)
    ON CONFLICT(kind) DO UPDATE SET
      last_failure_at=excluded.last_failure_at,
      last_failure_detail=excluded.last_failure_detail,
      updated_at=excluded.updated_at`)
    .run(kind, now, detail, now);
}

export async function pingExternalHeartbeat(kind: ExternalHeartbeatKind): Promise<{
  configured: boolean;
  delivered: boolean;
  detail: string | null;
}> {
  let url: URL | null;
  try {
    url = configuredUrl(kind);
  } catch (error) {
    const detail = safeDetail(error instanceof Error ? error.message : error);
    recordFailure(kind, detail);
    return { configured: true, delivered: false, detail };
  }
  if (!url) return { configured: false, delivered: false, detail: null };

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { "user-agent": "blog-garden-deadman-heartbeat" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`heartbeat endpoint returned HTTP ${response.status}`);
    recordSuccess(kind);
    return { configured: true, delivered: true, detail: null };
  } catch (error) {
    const detail = safeDetail(error instanceof Error ? error.message : error);
    recordFailure(kind, detail);
    return { configured: true, delivered: false, detail };
  }
}

export function externalHeartbeatStatus(kind: ExternalHeartbeatKind): ExternalHeartbeatStatus {
  const configured = Boolean(process.env[envName(kind)]?.trim());
  const row = db.prepare(`SELECT last_success_at,last_failure_at,last_failure_detail
    FROM external_heartbeat_deliveries WHERE kind=?`).get(kind) as {
      last_success_at: string | null;
      last_failure_at: string | null;
      last_failure_detail: string | null;
    } | undefined;
  return {
    kind,
    configured,
    lastSuccessAt: row?.last_success_at ?? null,
    lastFailureAt: row?.last_failure_at ?? null,
    lastFailureDetail: row?.last_failure_detail ?? null,
  };
}
