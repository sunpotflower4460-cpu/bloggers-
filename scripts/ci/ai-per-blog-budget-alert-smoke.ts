import Database from "better-sqlite3";
import http from "node:http";
import { rmSync } from "node:fs";

const dbPath = ".ci/ai-per-blog-budget-alert.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "40";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "10";
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
  const { applyBlogAiDailyCallLimitOverride } = await import("../../src/lib/ai-budget-operator");
  const { reserveAiCall } = await import("../../src/lib/ai-budget");
  const { reconcileAiPerBlogBudgetIncidents } = await import("../../src/lib/ai-per-blog-budget-alert");
  const { openOperationalIncidentsByCode } = await import("../../src/lib/incidents");

  const scope = blogAiUsageScope("alert-blog", "Alert Garden");
  await withAiUsageScope(scope, async () => {
    reserveAiCall("primary:model-a");
    reserveAiCall("fallback:model-b");
    reserveAiCall("economy:model-c");
    reserveAiCall("primary:model-d");
  });

  if (openOperationalIncidentsByCode("ai-per-blog-budget-near-limit").length !== 0
    || openOperationalIncidentsByCode("ai-per-blog-budget-exhausted").length !== 0) {
    throw new Error("per-blog incident existed before the settings change");
  }

  const db = new Database(dbPath);
  type Incident = { status: string; severity: string; detail: string; resolved_at: string | null };
  const incident = (code: string) => db.prepare(`SELECT status,severity,detail,resolved_at FROM operational_incidents
    WHERE code=? AND scope='blog:alert-blog'`).get(code) as Incident | undefined;
  const countRows = (code: string) => Number((db.prepare(`SELECT COUNT(*) n FROM operational_incidents
    WHERE code=? AND scope='blog:alert-blog'`).get(code) as { n: number }).n);

  // F-048 + F-042: 4/5 = 80%. Saving the override must immediately open the
  // advisory incident without waiting for the monitor, and must not make F-040
  // treat the blog as hard-cap protected.
  const near = await applyBlogAiDailyCallLimitOverride("alert-blog", 5);
  const nearRow = incident("ai-per-blog-budget-near-limit");
  if (!near.reconciled || near.warningScopes !== 1 || near.exhaustedScopes !== 0
    || near.notifications !== 1 || near.notificationFailures !== 0
    || !nearRow || nearRow.status !== "open" || !nearRow.detail.includes("80.0%") || !nearRow.detail.includes("4/5")) {
    throw new Error(`80% near-limit reconciliation is wrong: ${JSON.stringify({ near, nearRow })}`);
  }
  if (notifications.length !== 1 || notifications[0].severity !== "warning"
    || notifications[0].code !== "ai-per-blog-budget-near-limit") {
    throw new Error(`initial near-limit webhook missing: ${JSON.stringify(notifications)}`);
  }
  if (openOperationalIncidentsByCode("ai-per-blog-budget-exhausted").length !== 0) {
    throw new Error("F-040 must not show an 80% advisory as protected stop");
  }

  const duplicateNear = await reconcileAiPerBlogBudgetIncidents();
  if (duplicateNear.notifications !== 0 || notifications.length !== 1 || countRows("ai-per-blog-budget-near-limit") !== 1) {
    throw new Error(`near-limit warning duplicated: ${JSON.stringify({ duplicateNear, notifications: notifications.length })}`);
  }

  // 4/4 = 100%. This is escalation, not recovery. Near-limit must close silently
  // and the existing F-039 hard-cap incident must open with one WARNING.
  const exhausted = await applyBlogAiDailyCallLimitOverride("alert-blog", 4);
  const exhaustedRow = incident("ai-per-blog-budget-exhausted");
  const supersededNear = incident("ai-per-blog-budget-near-limit");
  if (!exhausted.reconciled || exhausted.exhaustedScopes !== 1 || exhausted.warningScopes !== 0
    || exhausted.notifications !== 1 || !exhaustedRow || exhaustedRow.status !== "open"
    || !exhaustedRow.detail.includes("4/4") || !supersededNear || supersededNear.status !== "closed") {
    throw new Error(`near-limit -> exhausted handoff is wrong: ${JSON.stringify({ exhausted, exhaustedRow, supersededNear })}`);
  }
  if (notifications.length !== 2 || notifications[1].severity !== "warning"
    || notifications[1].code !== "ai-per-blog-budget-exhausted") {
    throw new Error(`hard-cap escalation notification is wrong: ${JSON.stringify(notifications)}`);
  }

  // F-040 dashboard lookup remains code-specific even with many unrelated rows.
  const timestamp = new Date().toISOString();
  for (let index = 0; index < 25; index += 1) {
    db.prepare(`INSERT OR REPLACE INTO operational_incidents
      (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
      VALUES (?,?, 'open','warning',?,?,?,NULL,NULL)`)
      .run(`unrelated-${index}`, `system:${index}`, `unrelated ${index}`, timestamp, timestamp);
  }
  const openForHome = openOperationalIncidentsByCode("ai-per-blog-budget-exhausted");
  if (openForHome.length !== 1 || openForHome[0].scope !== "blog:alert-blog" || !openForHome[0].detail.includes("4/4")) {
    throw new Error(`F-040 home lookup missed the exhausted blog: ${JSON.stringify(openForHome)}`);
  }

  // Raising 4 -> 5 moves 100% -> 80%. That is a downgrade to WARNING, not a
  // full recovery. The exhausted row closes silently and near-limit reopens.
  const downgraded = await applyBlogAiDailyCallLimitOverride("alert-blog", 5);
  const downgradedExhausted = incident("ai-per-blog-budget-exhausted");
  const reopenedNear = incident("ai-per-blog-budget-near-limit");
  if (!downgraded.reconciled || downgraded.exhaustedScopes !== 0 || downgraded.warningScopes !== 1
    || downgraded.notifications !== 1 || !downgradedExhausted || downgradedExhausted.status !== "closed"
    || !reopenedNear || reopenedNear.status !== "open") {
    throw new Error(`exhausted -> near-limit downgrade is wrong: ${JSON.stringify({ downgraded, downgradedExhausted, reopenedNear })}`);
  }
  if (notifications.length !== 3 || notifications[2].severity !== "warning"
    || notifications[2].code !== "ai-per-blog-budget-near-limit") {
    throw new Error(`downgrade emitted a false recovery: ${JSON.stringify(notifications)}`);
  }
  if (openOperationalIncidentsByCode("ai-per-blog-budget-exhausted").length !== 0) {
    throw new Error("F-040 kept a downgraded hard-cap incident visible");
  }

  // Malformed shared config must not falsely recover an existing near-limit row.
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "abc";
  const invalid = await reconcileAiPerBlogBudgetIncidents();
  if (!invalid.configError || invalid.notifications !== 0 || incident("ai-per-blog-budget-near-limit")?.status !== "open"
    || notifications.length !== 3) {
    throw new Error(`invalid config did not preserve the advisory incident: ${JSON.stringify({ invalid, notifications: notifications.length })}`);
  }
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "10";

  // 4/6 = 66.7%. This is the first genuine recovery below 80%.
  const recovered = await applyBlogAiDailyCallLimitOverride("alert-blog", 6);
  const recoveredNear = incident("ai-per-blog-budget-near-limit");
  if (!recovered.reconciled || recovered.exhaustedScopes !== 0 || recovered.warningScopes !== 0
    || recovered.notifications !== 1 || !recoveredNear || recoveredNear.status !== "closed" || !recoveredNear.resolved_at) {
    throw new Error(`below-80 recovery is wrong: ${JSON.stringify({ recovered, recoveredNear })}`);
  }
  if (notifications.length !== 4 || notifications[3].severity !== "recovery"
    || notifications[3].code !== "ai-per-blog-budget-near-limit") {
    throw new Error(`genuine near-limit recovery webhook missing: ${JSON.stringify(notifications)}`);
  }

  // Re-enter F-039 hard-cap protection, then remove the override. Inheriting the
  // shared default 10 yields 40%, so settings-save reconciliation closes it now.
  const reopenedExhausted = await applyBlogAiDailyCallLimitOverride("alert-blog", 4);
  if (!reopenedExhausted.reconciled || reopenedExhausted.exhaustedScopes !== 1 || reopenedExhausted.warningScopes !== 0
    || notifications.length !== 5 || notifications[4].code !== "ai-per-blog-budget-exhausted") {
    throw new Error(`hard-cap did not reopen: ${JSON.stringify({ reopenedExhausted, notifications })}`);
  }
  const inherited = await applyBlogAiDailyCallLimitOverride("alert-blog", null);
  const inheritedRow = incident("ai-per-blog-budget-exhausted");
  if (!inherited.reconciled || inherited.exhaustedScopes !== 0 || inherited.warningScopes !== 0
    || inherited.notifications !== 1 || !inheritedRow || inheritedRow.status !== "closed") {
    throw new Error(`override removal did not recover onto shared default: ${JSON.stringify({ inherited, inheritedRow })}`);
  }
  if (notifications.length !== 6 || notifications[5].severity !== "recovery"
    || notifications[5].code !== "ai-per-blog-budget-exhausted") {
    throw new Error(`inheritance recovery webhook missing: ${JSON.stringify(notifications)}`);
  }

  // Reopen once more, then explicitly disable both layers. The recovery detail
  // must not claim observed usage itself fell.
  const reopenedAgain = await applyBlogAiDailyCallLimitOverride("alert-blog", 4);
  if (!reopenedAgain.reconciled || reopenedAgain.exhaustedScopes !== 1 || notifications.length !== 7) {
    throw new Error(`override did not reopen before explicit disable: ${JSON.stringify(reopenedAgain)}`);
  }
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "";
  const disabled = await applyBlogAiDailyCallLimitOverride("alert-blog", null);
  const disabledRow = incident("ai-per-blog-budget-exhausted");
  if (!disabled.reconciled || disabled.exhaustedScopes !== 0 || disabled.warningScopes !== 0
    || disabled.notifications !== 1 || !disabledRow || disabledRow.status !== "closed") {
    throw new Error(`explicit disable did not close hard-cap incident: ${JSON.stringify({ disabled, disabledRow })}`);
  }
  if (!disabledRow.detail.includes("無効化") || !disabledRow.detail.includes("使用量が減少したことを確認した復旧ではありません")) {
    throw new Error(`disable recovery detail overclaims usage recovery: ${disabledRow.detail}`);
  }
  if (notifications.length !== 8 || notifications[7].severity !== "recovery") {
    throw new Error(`disable recovery webhook missing: ${JSON.stringify(notifications)}`);
  }

  if (countRows("ai-per-blog-budget-near-limit") !== 1 || countRows("ai-per-blog-budget-exhausted") !== 1) {
    throw new Error(`stable incident codes created duplicate rows: ${JSON.stringify({ near: countRows("ai-per-blog-budget-near-limit"), exhausted: countRows("ai-per-blog-budget-exhausted") })}`);
  }
  if (openOperationalIncidentsByCode("ai-per-blog-budget-exhausted").length !== 0
    || openOperationalIncidentsByCode("ai-per-blog-budget-near-limit").length !== 0) {
    throw new Error("per-blog budget incidents remained open after explicit cap disable");
  }

  db.close();
  console.log(JSON.stringify({
    ok: true,
    notifications: notifications.map((item) => `${item.severity}:${item.code}`),
    nearLimitAt80Immediate: true,
    nearLimitDoesNotStopHomeCard: true,
    warningToHardCapNoFalseRecovery: true,
    hardCapToWarningNoFalseRecovery: true,
    genuineRecoveryOnlyBelow80: true,
    invalidConfigPreservesOpenIncident: true,
    settingsChangesReconcileImmediately: true,
    stableIncidentRows: true,
    explicitDisableRecoveryDoesNotClaimSpendDrop: true,
  }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
