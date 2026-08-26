import Database from "better-sqlite3";
import http from "node:http";
import { rmSync } from "node:fs";

const dbPath = ".ci/ai-per-blog-budget-alert.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "20";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "2";
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
if (!address || typeof address === "string") throw new Error("mock webhook did not bind a TCP port");
process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${address.port}/webhook`;

try {
  const { blogAiUsageScope, withAiUsageScope } = await import("../../src/lib/ai-usage-context");
  const { reserveAiCall } = await import("../../src/lib/ai-budget");
  const { reconcileAiPerBlogBudgetIncidents } = await import("../../src/lib/ai-per-blog-budget-alert");

  const scope = blogAiUsageScope("alert-blog", "Alert Garden");
  await withAiUsageScope(scope, async () => {
    reserveAiCall("primary:model-a");
    reserveAiCall("fallback:model-b");
  });

  const first = await reconcileAiPerBlogBudgetIncidents();
  if (!first.configured || first.exhaustedScopes !== 1 || first.notifications !== 1 || first.notificationFailures !== 0) {
    throw new Error(`first exhaustion reconciliation is wrong: ${JSON.stringify(first)}`);
  }
  if (notifications.length !== 1 || notifications[0].severity !== "warning") {
    throw new Error(`initial warning webhook missing: ${JSON.stringify(notifications)}`);
  }

  const db = new Database(dbPath);
  const incident = () => db.prepare(`SELECT status,severity,detail,resolved_at FROM operational_incidents
    WHERE code='ai-per-blog-budget-exhausted' AND scope='blog:alert-blog'`).get() as
      | { status: string; severity: string; detail: string; resolved_at: string | null }
      | undefined;
  const countRows = () => Number((db.prepare(`SELECT COUNT(*) n FROM operational_incidents
    WHERE code='ai-per-blog-budget-exhausted' AND scope='blog:alert-blog'`).get() as { n: number }).n);

  const opened = incident();
  if (!opened || opened.status !== "open" || opened.severity !== "warning" || !opened.detail.includes("2/2")) {
    throw new Error(`persistent per-blog incident was not opened correctly: ${JSON.stringify(opened)}`);
  }

  const duplicate = await reconcileAiPerBlogBudgetIncidents();
  if (duplicate.notifications !== 0 || notifications.length !== 1 || countRows() !== 1) {
    throw new Error(`persistent warning was duplicated: ${JSON.stringify({ duplicate, notifications: notifications.length, rows: countRows() })}`);
  }

  // Raising the cap clears the actual blocking condition without mutating usage.
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "3";
  const recovered = await reconcileAiPerBlogBudgetIncidents();
  const closed = incident();
  if (recovered.exhaustedScopes !== 0 || recovered.notifications !== 1 || !closed || closed.status !== "closed" || !closed.resolved_at) {
    throw new Error(`cap increase did not close the incident: ${JSON.stringify({ recovered, closed })}`);
  }
  if (notifications.length !== 2 || notifications[1].severity !== "recovery") {
    throw new Error(`recovery webhook missing after cap increase: ${JSON.stringify(notifications)}`);
  }

  // Lowering the limit below already-consumed calls reopens the SAME incident row.
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "1";
  const reopened = await reconcileAiPerBlogBudgetIncidents();
  const reopenedRow = incident();
  if (reopened.exhaustedScopes !== 1 || reopened.notifications !== 1 || !reopenedRow || reopenedRow.status !== "open" || countRows() !== 1) {
    throw new Error(`closed incident was not safely reopened: ${JSON.stringify({ reopened, reopenedRow, rows: countRows() })}`);
  }
  if (notifications.length !== 3 || notifications[2].severity !== "warning") {
    throw new Error(`reopen warning webhook missing: ${JSON.stringify(notifications)}`);
  }

  // Bad optional config must not crash the whole monitor and must not falsely
  // announce recovery while the previous protective stop is unresolved.
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "abc";
  const invalid = await reconcileAiPerBlogBudgetIncidents();
  if (!invalid.configError || invalid.notifications !== 0 || incident()?.status !== "open" || notifications.length !== 3) {
    throw new Error(`invalid config was not isolated conservatively: ${JSON.stringify({ invalid, incident: incident(), notifications: notifications.length })}`);
  }

  // Explicit operator disable ends the monitoring condition, but recovery text
  // must not pretend observed AI usage itself fell.
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "";
  const disabled = await reconcileAiPerBlogBudgetIncidents();
  const disabledRow = incident();
  if (disabled.configured || disabled.notifications !== 1 || !disabledRow || disabledRow.status !== "closed") {
    throw new Error(`explicit disable did not close the incident: ${JSON.stringify({ disabled, disabledRow })}`);
  }
  if (!disabledRow.detail.includes("無効化") || !disabledRow.detail.includes("使用量が減少したことを確認した復旧ではありません")) {
    throw new Error(`disable recovery detail overclaims usage recovery: ${disabledRow.detail}`);
  }
  if (notifications.length !== 4 || notifications[3].severity !== "recovery") {
    throw new Error(`disable recovery webhook missing: ${JSON.stringify(notifications)}`);
  }
  if (countRows() !== 1) throw new Error(`incident lifecycle created duplicate rows: ${countRows()}`);

  db.close();
  console.log(JSON.stringify({
    ok: true,
    notifications: notifications.map((item) => item.severity),
    onePersistentIncidentRow: true,
    invalidConfigPreservesOpenIncident: true,
    explicitDisableRecoveryDoesNotClaimSpendDrop: true,
  }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
