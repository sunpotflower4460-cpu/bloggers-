import Database from "better-sqlite3";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pingExternalHeartbeat } from "../lib/external-heartbeat";

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

const databasePath = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
const backupDir = resolve(process.env.BACKUP_DIR || "./backups");
const retentionDays = positiveInt(process.env.BACKUP_RETENTION_DAYS, 30);
mkdirSync(backupDir, { recursive: true });

const output = join(backupDir, `blog-garden-${stamp()}.sqlite`);
const source = new Database(databasePath, { fileMustExist: true });
source.pragma("busy_timeout = 5000");

try {
  await source.backup(output);
} finally {
  source.close();
}

const verify = new Database(output, { readonly: true, fileMustExist: true });
let integrity: unknown;
try {
  integrity = verify.pragma("integrity_check", { simple: true });
} finally {
  verify.close();
}
if (String(integrity).toLowerCase() !== "ok") {
  rmSync(output, { force: true });
  throw new Error(`Backup integrity_check failed: ${String(integrity)}`);
}

const cutoff = Date.now() - retentionDays * 86400000;
let pruned = 0;
for (const name of readdirSync(backupDir)) {
  if (!/^blog-garden-\d{8}-\d{6}Z\.sqlite$/.test(name)) continue;
  const file = join(backupDir, name);
  if (file === output) continue;
  try {
    if (statSync(file).mtimeMs < cutoff) {
      rmSync(file, { force: true });
      pruned += 1;
    }
  } catch {
    // A concurrently removed old backup is harmless.
  }
}

// Only a fully-created and integrity-verified backup earns a success heartbeat.
// If the external monitor itself is unavailable, the backup remains successful;
// the dead-man service will observe the missing ping independently.
const external = await pingExternalHeartbeat("backup");
if (external.configured && !external.delivered) {
  console.error(`[backup] external dead-man heartbeat delivery failed: ${external.detail || "unknown error"}`);
}

console.log(JSON.stringify({
  ok: true,
  backup: basename(output),
  database: basename(databasePath),
  retentionDays,
  pruned,
  externalHeartbeat: { configured: external.configured, delivered: external.delivered },
  createdAt: new Date().toISOString(),
}));
