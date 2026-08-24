import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const dbPath = ".ci/external-heartbeat.sqlite";
const backupDir = ".ci/external-heartbeat-backups";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(backupDir, { recursive: true, force: true });
mkdirSync(backupDir, { recursive: true });

const hits = { worker: 0, backup: 0, redirectedTarget: 0 };
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/worker") {
    hits.worker += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname === "/backup") {
    hits.backup += 1;
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: "/redirected-target?secret=should-never-arrive" });
    res.end();
    return;
  }
  if (url.pathname === "/redirected-target") {
    hits.redirectedTarget += 1;
    res.writeHead(200);
    res.end("unexpected");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind heartbeat mock server");
const port = address.port;

function run(command: string, args: string[], extraEnv: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`child failed (${code}): ${stderr || stdout}`));
      else resolve({ stdout, stderr });
    });
  });
}

try {
  const common = {
    DATABASE_PATH: dbPath,
    NODE_ENV: "development",
    AI_API_KEY: "ci-unused",
    AI_MODEL: "ci-unused",
  };

  const workerUrl = `http://127.0.0.1:${port}/worker?secret=worker-deadman-token`;
  const worker = await run("./node_modules/.bin/tsx", ["src/cli/daily.ts"], {
    ...common,
    EXTERNAL_WORKER_HEARTBEAT_URL: workerUrl,
  });
  if (hits.worker !== 1) throw new Error(`worker CLI did not emit exactly one heartbeat: ${hits.worker}`);
  if (!worker.stdout.includes('"delivered": true')) throw new Error("worker CLI did not report delivered heartbeat");
  if (worker.stdout.includes("worker-deadman-token") || worker.stderr.includes("worker-deadman-token")) {
    throw new Error("worker heartbeat secret leaked to CLI output");
  }

  const backupUrl = `http://127.0.0.1:${port}/backup?secret=backup-deadman-token`;
  const backup = await run("./node_modules/.bin/tsx", ["src/cli/backup.ts"], {
    ...common,
    BACKUP_DIR: backupDir,
    BACKUP_RETENTION_DAYS: "1",
    EXTERNAL_BACKUP_HEARTBEAT_URL: backupUrl,
  });
  if (hits.backup !== 1) throw new Error(`backup CLI did not emit exactly one heartbeat: ${hits.backup}`);
  if (!backup.stdout.includes('"delivered":true')) throw new Error("backup CLI did not report delivered heartbeat");
  if (backup.stdout.includes("backup-deadman-token") || backup.stderr.includes("backup-deadman-token")) {
    throw new Error("backup heartbeat secret leaked to CLI output");
  }

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = "development";
  const { externalHeartbeatStatus, pingExternalHeartbeat } = await import("../../src/lib/external-heartbeat");

  const workerStatus = externalHeartbeatStatus("worker");
  const backupStatus = externalHeartbeatStatus("backup");
  if (!workerStatus.lastSuccessAt || !backupStatus.lastSuccessAt) {
    throw new Error("successful CLI heartbeats were not persisted locally");
  }

  process.env.EXTERNAL_WORKER_HEARTBEAT_URL = `http://127.0.0.1:${port}/redirect?token=redirect-super-secret`;
  const redirect = await pingExternalHeartbeat("worker");
  if (redirect.delivered || hits.redirectedTarget !== 0) throw new Error("heartbeat followed a redirect");
  if ((redirect.detail || "").includes("redirect-super-secret")) throw new Error("redirect heartbeat secret leaked to error detail");

  process.env.NODE_ENV = "production";
  process.env.EXTERNAL_BACKUP_HEARTBEAT_URL = `http://127.0.0.1:${port}/backup?token=production-super-secret`;
  const insecure = await pingExternalHeartbeat("backup");
  if (insecure.delivered || !insecure.detail?.includes("must use HTTPS")) {
    throw new Error(`production HTTP heartbeat was not rejected: ${JSON.stringify(insecure)}`);
  }
  if (insecure.detail.includes("production-super-secret") || insecure.detail.includes(`127.0.0.1:${port}`)) {
    throw new Error("production heartbeat error leaked URL/token");
  }

  console.log(JSON.stringify({ ok: true, hits, workerStatus, backupStatus }));
} finally {
  server.close();
}
