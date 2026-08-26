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
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "5";
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
  const { setBlogAiDailyCallLimitOverride } = await import("../../src/lib/ai-budget-overrides");
  const { reserveAiCall } = await import("../../src/lib/ai-budget");
  const { reconcileAiPerBlogBudgetIncidents } = await import("../../src/lib/ai-per-blog-budget-alert");
  const { openOperationalIncidentsByCode } = await import("../../src/lib/incidents");

  const scope = blogAiUsageScope("alert-blog", "Alert Garden");
  setBlogAiDailyCallLimitOverride("alert-blog", 2);
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
  if (!opened || opened.status !== "open" || opened.severity !== "warning" || !opened.detail.includes("2/2") || !opened.detail.includes("個別override")) {
    throw new Error(`persistent per-blog override incident was not opened correctly: ${JSON.stringify(opened)}`);
  }

  // F-040 dashboard lookup must be code-specific and unbounded by unrelated
  // recent incidents. Add enough unrelated OPEN rows to exceed the old generic
  // recent-incident list size, then verify this blog is still returned.
  const timestamp = new Date().toISOString();
  for (let index = 0; index < 25; index += 1) {
    db.prepare(`INSERT OR REPLACE INTO operational_incidents
      (code,scope,status,severity,detail,opened_at,updated_at,last_notified_at,resolved_at)
      VALUES (?,?, 'open','warning',?,?,?,NULL,NULL)`)
      .run(`unrelated-${index}`, `system:${index}`, `unrelated ${index}`, timestamp, timestamp);
  }
  const openForHome = openOperationalIncidentsByCode("ai-per-blog-budget-exhausted");
  if (openForHome.length !== 1 || openForHome[0].scope !== "blog:alert-blog" || !openForHome[0].detail.includes("2/2")) {
    throw new Error(`F-040 home incident lookup missed the exhausted blog: ${JSON.stringify(openForHome)}`);
  }

  const duplicate = await reconcileAiPerBlogBudgetIncidents();
  if (duplicate.notifications !== 0 || notifications.length !== 1 || countRows() !== 1) {
    throw new Error(`persistent warning was duplicated: ${JSON.stringify({ duplicate, notifications: notifications.length, rows: countRows() })}`);
  }

  // Raising THIS BLOG'S override clears the actual blocking condition even
  // though the shared default stays at 5.
  setBlogAiDailyCallLimitOverride("alert-blog", 3);
  const recovered = await reconcileAiPerBlogBudgetIncidents();
  const closed = incident();
  if (recovered.exhaustedScopes !== 0 || recovered.notifications !== 1 || !closed || closed.status !== "closed" || !closed.resolved_at) {
    throw new Error(`override increase did not close the incident: ${JSON.stringify({ recovered, closed })}`);
  }
  if (notifications.length !== 2 || notifications[1].severity !== "recovery") {
    throw new Error(`recovery webhook missing after override increase: ${JSON.stringify(notifications)}`);
  }
  if (openOperationalIncidentsByCode("ai-per-blog-budget-exhausted").length !== 0) {
    throw new Error("F-040 home lookup kept a CLOSED budget incident visible");
  }

  // Lowering the override below already-consumed calls reopens the SAME row.
  setBlogAiDailyCallLimitOverride("alert-blog", 1);
  const reopened = await reconcileAiPerBlogBudgetIncidents();
  const reopenedRow = incident();
  if (reopened.exhaustedScopes !== 1 || reopened.notifications !== 1 || !reopenedRow || reopenedRow.status !== "open" || countRows() !== 1) {
    throw new Error(`closed incident was not safely reopened by override: ${JSON.stringify({ reopened, reopenedRow, rows: countRows() })}`);
  }
  if (notifications.length !== 3 || notifications[2].severity !== "warning") {
    throw new Error(`reopen warning webhook missing: ${JSON.stringify(notifications)}`);
  }
  if (openOperationalIncidentsByCode("ai-per-blog-budget-exhausted")[0]?.scope !== "blog:alert-blog") {
    throw new Error("F-040 home lookup did not restore the reopened budget incident");
  }

  // A malformed shared default must not crash the whole monitor or falsely
  // close an existing incident. aiPerBlogBudgetStatus validates global config
  // before producing a complete status snapshot.
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "abc";
  const invalid = await reconcileAiPerBlogBudgetIncidents();
  if (!invalid.configError || invalid.notifications !== 0 || incident()?.status !== "open" || notifications.length !== 3) {
    throw new Error(`invalid config was not isolated conservatively: ${JSON.stringify({ invalid, incident: incident(), notifications: notifications.length })}`);
  }

  // Removing this override while restoring the valid shared default makes the
  // blog inherit 5; its 2 calls are no longer exhausted and the incident closes.
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "5";
  setBlogAiDailyCallLimitOverride("alert-blog", null);
  const inherited = await reconcileAiPerBlogBudgetIncidents();
  const inheritedRow = incident();
  if (!inherited.configured || inherited.exhaustedScopes !== 0 || inherited.notifications !== 1 || !inheritedRow || inheritedRow.status !== "closed") {
    throw new Error(`override removal did not recover onto the shared default: ${JSON.stringify({ inherited, inheritedRow })}`);
  }
  if (notifications.length !== 4 || notifications[3].severity !== "recovery") {
    throw new Error(`inheritance recovery webhook missing: ${JSON.stringify(notifications)}`);
  }

  // Reopen under an override, then explicitly disable both layers. Recovery
  // must not pretend observed AI usage itself fell.
  setBlogAiDailyCallLimitOverride("alert-blog", 1);
  const reopenedAgain = await reconcileAiPerBlogBudgetIncidents();
  if (reopenedAgain.exhaustedScopes !== 1 || notifications.length !== 5 || notifications[4].severity !== "warning") {
    throw new Error(`override did not reopen before explicit disable: ${JSON.stringify({ reopenedAgain, notifications })}`);
  }
  setBlogAiDailyCallLimitOverride("alert-blog", null);
  process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "";
  const disabled = await reconcileAiPerBlogBudgetIncidents();
  const disabledRow = incident();
  if (disabled.configured || disabled.notifications !== 1 || !disabledRow || disabledRow.status !== "closed") {
    throw new Error(`explicit disable did not close the incident: ${JSON.stringify({ disabled, disabledRow })}`);
  }
  if (!disabledRow.detail.includes("無効化") || !disabledRow.detail.includes("使用量が減少したことを確認した復旧ではありません")) {
    throw new Error(`disable recovery detail overclaims usage recovery: ${disabledRow.detail}`);
  }
  if (notifications.length !== 6 || notifications[5].severity !== "recovery") {
    throw new Error(`disable recovery webhook missing: ${JSON.stringify(notifications)}`);
  }
  if (countRows() !== 1) throw new Error(`incident lifecycle created duplicate rows: ${countRows()}`);
  if (openOperationalIncidentsByCode("ai-per-blog-budget-exhausted").length !== 0) {
    throw new Error("F-040 home lookup shows an incident after explicit cap disable");
  }

  db.close();
  console.log(JSON.stringify({
    ok: true,
    notifications: notifications.map((item) => item.severity),
    onePersistentIncidentRow: true,
    overrideOpensAndRecoversIncident: true,
    invalidConfigPreservesOpenIncident: true,
    clearedOverrideInheritsSharedDefault: true,
    explicitDisableRecoveryDoesNotClaimSpendDrop: true,
    homeLookupIgnoresUnrelatedIncidentVolume: true,
    closedIncidentsHiddenFromHome: true,
  }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
