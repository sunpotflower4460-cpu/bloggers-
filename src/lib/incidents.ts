import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type DB = InstanceType<typeof Database>;

export interface OperationalIncidentSummary {
  code: string;
  scope: string;
  status: "open" | "closed";
  severity: "warning" | "critical";
  detail: string;
  openedAt: string;
  updatedAt: string;
  lastNotifiedAt: string | null;
  resolvedAt: string | null;
}

const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenIncidentDb?: DB };
const db = globalDb.__blogGardenIncidentDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenIncidentDb = db;
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

export function recentOperationalIncidents(limit = 20): OperationalIncidentSummary[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db.prepare(`SELECT code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at
    FROM operational_incidents
    ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,
             CASE WHEN severity='critical' THEN 0 ELSE 1 END,
             updated_at DESC
    LIMIT ?`).all(safeLimit) as Array<{
      code: string;
      scope: string;
      status: string;
      severity: string;
      detail: string;
      opened_at: string;
      updated_at: string;
      last_notified_at: string | null;
      resolved_at: string | null;
    }>;
  return rows.map((row) => ({
    code: row.code,
    scope: row.scope,
    status: row.status === "open" ? "open" : "closed",
    severity: row.severity === "critical" ? "critical" : "warning",
    detail: row.detail,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    lastNotifiedAt: row.last_notified_at,
    resolvedAt: row.resolved_at,
  }));
}
