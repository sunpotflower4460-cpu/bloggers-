import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function integrityCheck(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let integrity: unknown;
  try {
    integrity = db.pragma("integrity_check", { simple: true });
  } finally {
    db.close();
  }
  if (String(integrity).toLowerCase() !== "ok") throw new Error(`SQLite integrity_check failed for ${basename(file)}: ${String(integrity)}`);
}

if (process.env.CONFIRM_RESTORE !== "RESTORE") {
  throw new Error("Refusing destructive restore. Stop web/worker/backup first, then set CONFIRM_RESTORE=RESTORE explicitly.");
}

const rawBackup = process.env.BACKUP_FILE;
if (!rawBackup) throw new Error("BACKUP_FILE is required");
const backupFile = resolve(rawBackup);
const databasePath = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
const backupDir = resolve(process.env.BACKUP_DIR || "./backups");
if (!existsSync(backupFile)) throw new Error(`Backup file not found: ${backupFile}`);
if (backupFile === databasePath) throw new Error("BACKUP_FILE must not be the live database path");

integrityCheck(backupFile);
mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(backupDir, { recursive: true });

let safetyBackup: string | null = null;
if (existsSync(databasePath)) {
  safetyBackup = join(backupDir, `pre-restore-${stamp()}.sqlite`);
  const current = new Database(databasePath, { fileMustExist: true });
  try {
    await current.backup(safetyBackup);
  } finally {
    current.close();
  }
  integrityCheck(safetyBackup);
}

const staged = `${databasePath}.restore-${process.pid}.tmp`;
copyFileSync(backupFile, staged);
try {
  integrityCheck(staged);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  renameSync(staged, databasePath);
  integrityCheck(databasePath);
} catch (error) {
  rmSync(staged, { force: true });
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  restoredFrom: basename(backupFile),
  database: basename(databasePath),
  safetyBackup: safetyBackup ? basename(safetyBackup) : null,
  restoredAt: new Date().toISOString(),
}));
