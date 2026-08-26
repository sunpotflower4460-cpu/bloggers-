import Database from "better-sqlite3";
import http from "node:http";
import { rmSync } from "node:fs";

const dbPath = ".ci/ai-budget-warning.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "10";
process.env.AI_DAILY_TOKEN_LIMIT = "1000";
process.env.ALERT_WEBHOOK_KIND = "generic";

const notifications: Array<Record<string, unknown>> = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    try {
      notifications.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("bad json");
    }
  });
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock webhook did not bind");
process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${address.port}/webhook`;

try {
  const { reserveAiCall } = await import("../../src/lib/ai-budget");
  const { reconcileAiBudgetIncident } = await import("../../src/lib/ai-budget-alert");

  for (let index = 0; index < 8; index += 1) reserveAiCall("primary:warning-fixture");
  const warning = await reconcileAiBudgetIncident();
  if (warning.exhausted || !warning.warning || !warning.notified || warning.notificationFailure) {
    throw new Error(`80% warning did not open correctly: ${JSON.stringify(warning)}`);
  }
  if (notifications.length !== 1 || notifications[0].severity !== "warning" || notifications[0].code !== "ai-budget-near-limit") {
    throw new Error(`warning webhook missing: ${JSON.stringify(notifications)}`);
  }

  const duplicate = await reconcileAiBudgetIncident();
  if (!duplicate.warning || duplicate.notified || notifications.length !== 1) {
    throw new Error(`near-limit warning duplicated: ${JSON.stringify({ duplicate, notifications })}`);
  }

  reserveAiCall("primary:warning-fixture");
  reserveAiCall("primary:warning-fixture");
  const critical = await reconcileAiBudgetIncident();
  if (!critical.exhausted || critical.warning || !critical.notified || critical.notificationFailure) {
    throw new Error(`critical escalation failed: ${JSON.stringify(critical)}`);
  }
  if (notifications.length !== 2 || notifications[1].severity !== "critical" || notifications[1].code !== "ai-budget-exhausted") {
    throw new Error(`critical webhook missing or warning emitted false recovery: ${JSON.stringify(notifications)}`);
  }

  const db = new Database(dbPath);
  const row = (code: string) => db.prepare("SELECT status,severity,detail,resolved_at FROM operational_incidents WHERE code=? AND scope='system'")
    .get(code) as { status: string; severity: string; detail: string; resolved_at: string | null } | undefined;
  const warningAtCritical = row("ai-budget-near-limit");
  const criticalOpen = row("ai-budget-exhausted");
  if (!warningAtCritical || warningAtCritical.status !== "closed" || !warningAtCritical.detail.includes("CRITICALへ引き継ぎ")) {
    throw new Error(`warning was not silently superseded at hard cap: ${JSON.stringify(warningAtCritical)}`);
  }
  if (!criticalOpen || criticalOpen.status !== "open" || criticalOpen.severity !== "critical") {
    throw new Error(`critical incident was not open: ${JSON.stringify(criticalOpen)}`);
  }

  // Simulate an operator raising the effective global cap enough to move from
  // 100% to 90%. This is a downgrade to WARNING, not a full recovery.
  process.env.AI_DAILY_CALL_LIMIT = "11";
  const downgraded = await reconcileAiBudgetIncident();
  if (downgraded.exhausted || !downgraded.warning || !downgraded.notified) {
    throw new Error(`critical did not downgrade to warning: ${JSON.stringify(downgraded)}`);
  }
  if (notifications.length !== 3 || notifications[2].severity !== "warning" || notifications.some((item, index) => index < 3 && item.severity === "recovery")) {
    throw new Error(`downgrade emitted an incorrect recovery: ${JSON.stringify(notifications)}`);
  }
  if (row("ai-budget-exhausted")?.status !== "closed" || row("ai-budget-near-limit")?.status !== "open") {
    throw new Error(`incident rows did not transition critical -> warning: ${JSON.stringify({ critical: row("ai-budget-exhausted"), warning: row("ai-budget-near-limit") })}`);
  }

  // Raise the cap again so 10 calls are below 80%. Only now should WARNING
  // close with a genuine RECOVERY notification.
  process.env.AI_DAILY_CALL_LIMIT = "13";
  const recovered = await reconcileAiBudgetIncident();
  if (recovered.exhausted || recovered.warning || !recovered.notified) {
    throw new Error(`warning did not recover below 80%: ${JSON.stringify(recovered)}`);
  }
  if (notifications.length !== 4 || notifications[3].severity !== "recovery" || notifications[3].code !== "ai-budget-near-limit") {
    throw new Error(`warning recovery webhook missing: ${JSON.stringify(notifications)}`);
  }

  // Token utilization uses the same 80% threshold. Keep calls healthy and
  // directly seed metered global token totals for an isolated token warning.
  db.prepare("UPDATE ai_usage_daily SET total_tokens=800,input_tokens=500,output_tokens=300").run();
  process.env.AI_DAILY_TOKEN_LIMIT = "1000";
  const tokenWarning = await reconcileAiBudgetIncident();
  if (!tokenWarning.warning || tokenWarning.exhausted || !tokenWarning.notified) {
    throw new Error(`token utilization did not reopen warning: ${JSON.stringify(tokenWarning)}`);
  }
  if (notifications.length !== 5 || notifications[4].severity !== "warning" || !String(notifications[4].detail || "").includes("tokens 800/1000")) {
    throw new Error(`token warning webhook missing: ${JSON.stringify(notifications)}`);
  }

  const counts = db.prepare("SELECT code,COUNT(*) n FROM operational_incidents WHERE code IN ('ai-budget-near-limit','ai-budget-exhausted') GROUP BY code").all() as Array<{ code: string; n: number }>;
  if (counts.some((item) => item.n !== 1) || counts.length !== 2) {
    throw new Error(`budget lifecycle created duplicate incident rows: ${JSON.stringify(counts)}`);
  }
  db.close();

  console.log(JSON.stringify({
    ok: true,
    warningAt80Percent: true,
    duplicateWarningSuppressed: true,
    criticalEscalationHasNoFalseRecovery: true,
    criticalDowngradeHasNoFalseRecovery: true,
    recoveryOnlyBelow80Percent: true,
    tokenWarningCovered: true,
    onePersistentRowPerIncidentCode: true,
  }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
