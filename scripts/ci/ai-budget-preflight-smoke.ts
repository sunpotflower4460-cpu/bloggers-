import Database from "better-sqlite3";
import { rmSync } from "node:fs";

const dbPath = ".ci/ai-budget-preflight.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.APP_ENCRYPTION_KEY = "0".repeat(64);
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "20";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "1";

const { encryptJson } = await import("../../src/lib/crypto");
const { createBlog, getBlog, recordPublication } = await import("../../src/lib/db");
const { blogAiUsageScope, withAiUsageScope } = await import("../../src/lib/ai-usage-context");
const { aiBudgetStatus, reserveAiCall } = await import("../../src/lib/ai-budget");
const { runGarden } = await import("../../src/lib/engine");

function createTestBlog(name: string, publishMode: "auto" | "review" = "auto") {
  return createBlog({
    name,
    niche: "CI budget protection",
    platform: "wordpress",
    siteUrl: "https://example.invalid",
    keywords: ["ci"],
    feeds: [],
    credentialsCipher: encryptJson({}),
    publishMode,
    cadenceHours: 24,
    dailyLimit: 1,
    language: "ja",
    timezone: "UTC",
    ga4PropertyId: null,
    searchConsoleSiteUrl: null,
    active: true,
  });
}

const perBlog = createTestBlog("Per Blog Protected Garden", "review");
const globalBlog = createTestBlog("Global Protected Garden", "review");

// Consume the only per-blog slot. The authoritative reservation succeeds and
// leaves the blog exactly at 1/1 without exhausting the global 20-call budget.
await withAiUsageScope(blogAiUsageScope(perBlog.id, perBlog.name), async () => {
  reserveAiCall("primary:preflight-fixture");
});
const beforePerBlogRun = aiBudgetStatus();
if (beforePerBlogRun.calls !== 1) throw new Error(`fixture did not reserve exactly one AI call: ${JSON.stringify(beforePerBlogRun)}`);

const perBlogResult = await runGarden(perBlog.id, { force: true });
if (perBlogResult.length !== 1 || perBlogResult[0].status !== "budget-blocked") {
  throw new Error(`per-blog exhausted run was not a protected skip: ${JSON.stringify(perBlogResult)}`);
}
const afterPerBlogRun = aiBudgetStatus();
if (afterPerBlogRun.calls !== 1) {
  throw new Error(`protected preflight consumed another AI call: ${JSON.stringify(afterPerBlogRun)}`);
}
if (getBlog(perBlog.id)?.lastRunAt !== null) {
  throw new Error("protected budget skip advanced lastRunAt and could delay the next budget-day recovery run");
}

const db = new Database(dbPath);
function editorialErrors(blogId: string): number {
  return Number((db.prepare("SELECT COUNT(*) n FROM run_logs WHERE blog_id=? AND kind='editorial' AND status='error'").get(blogId) as { n: number }).n);
}
function protectedSkips(blogId: string): Array<{ message: string; meta_json: string }> {
  return db.prepare("SELECT message,meta_json FROM run_logs WHERE blog_id=? AND kind='execution' AND status='ok' AND message LIKE 'Protected AI editorial skip:%' ORDER BY id DESC")
    .all(blogId) as Array<{ message: string; meta_json: string }>;
}

if (editorialErrors(perBlog.id) !== 0) {
  throw new Error("expected per-blog budget protection was incorrectly recorded as an editorial error");
}
const perBlogSkip = protectedSkips(perBlog.id)[0];
if (!perBlogSkip?.message.includes("Protected AI editorial skip") || !perBlogSkip.message.includes("per-blog")) {
  throw new Error(`per-blog protected execution log missing: ${JSON.stringify(perBlogSkip)}`);
}
const perBlogMeta = JSON.parse(perBlogSkip.meta_json) as { aiBudgetPreflight?: { reason?: string } };
if (perBlogMeta.aiBudgetPreflight?.reason !== "per-blog-call-limit") {
  throw new Error(`per-blog protected reason was not persisted: ${perBlogSkip.meta_json}`);
}

// F-044: repeated worker/manual attempts in the SAME protected episode still
// return budget-blocked, but must not append another identical execution log.
const duplicatePerBlog = await runGarden(perBlog.id, { force: true });
if (duplicatePerBlog[0]?.status !== "budget-blocked") {
  throw new Error(`repeated protected run lost API status: ${JSON.stringify(duplicatePerBlog)}`);
}
if (protectedSkips(perBlog.id).length !== 1) {
  throw new Error(`same protected episode created duplicate logs: ${protectedSkips(perBlog.id).length}`);
}

// A reason change on the same day is a real transition and must be logged.
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "";
process.env.AI_DAILY_CALL_LIMIT = "1";
const changedReason = await runGarden(perBlog.id, { force: true });
if (changedReason[0]?.status !== "budget-blocked" || protectedSkips(perBlog.id).length !== 2) {
  throw new Error(`budget reason transition was not logged: ${JSON.stringify({ changedReason, logs: protectedSkips(perBlog.id).length })}`);
}
const changedReasonMeta = JSON.parse(protectedSkips(perBlog.id)[0].meta_json) as { aiBudgetPreflight?: { reason?: string } };
if (changedReasonMeta.aiBudgetPreflight?.reason !== "global-call-limit") {
  throw new Error(`reason transition did not persist global-call-limit: ${protectedSkips(perBlog.id)[0].meta_json}`);
}

// A healthy preflight must clear the episode marker. Avoid all real network/AI
// work by placing a same-day publication and using a non-force review-mode run,
// which safely returns daily-limit immediately after the healthy preflight.
process.env.AI_DAILY_CALL_LIMIT = "20";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "2";
recordPublication({
  blogId: perBlog.id,
  platformPostId: "ci-existing",
  title: "CI existing publication",
  url: "https://example.invalid/ci-existing",
  status: "draft",
  sourceUrls: [],
  publishedAt: null,
});
const healthy = await runGarden(perBlog.id);
if (healthy[0]?.status !== "daily-limit") {
  throw new Error(`healthy preflight did not reach safe daily-limit exit: ${JSON.stringify(healthy)}`);
}

// Same-day re-entry into the original per-blog reason is a NEW protected
// episode after recovery and therefore must append one new transition log.
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "1";
const reentered = await runGarden(perBlog.id, { force: true });
if (reentered[0]?.status !== "budget-blocked" || protectedSkips(perBlog.id).length !== 3) {
  throw new Error(`same-day recovery/re-entry transition was lost: ${JSON.stringify({ reentered, logs: protectedSkips(perBlog.id).length })}`);
}

// Simulate the persisted marker belonging to a previous budget day. The next
// blocked run must create a fresh daily transition even with the same reason.
db.prepare("UPDATE ai_budget_preflight_state SET day_key='1900-01-01' WHERE blog_id=?").run(perBlog.id);
const nextDayTransition = await runGarden(perBlog.id, { force: true });
if (nextDayTransition[0]?.status !== "budget-blocked" || protectedSkips(perBlog.id).length !== 4) {
  throw new Error(`new budget-day transition was not logged: ${JSON.stringify({ nextDayTransition, logs: protectedSkips(perBlog.id).length })}`);
}

// Test a separate blog at the GLOBAL limit. Its protected state must remain
// independent from the first blog's transition marker.
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "";
process.env.AI_DAILY_CALL_LIMIT = "1";
const globalResult = await runGarden(globalBlog.id, { force: true });
if (globalResult.length !== 1 || globalResult[0].status !== "budget-blocked") {
  throw new Error(`global exhausted run was not a protected skip: ${JSON.stringify(globalResult)}`);
}
if (aiBudgetStatus().calls !== 1) throw new Error("global protected preflight changed AI call usage");
if (editorialErrors(globalBlog.id) !== 0) throw new Error("global budget protection was incorrectly recorded as an editorial error");
const globalSkip = protectedSkips(globalBlog.id)[0];
const globalMeta = globalSkip ? JSON.parse(globalSkip.meta_json) as { aiBudgetPreflight?: { reason?: string } } : null;
if (globalMeta?.aiBudgetPreflight?.reason !== "global-call-limit") {
  throw new Error(`global protected reason was not persisted: ${JSON.stringify(globalSkip)}`);
}

// F-043 must not hide malformed safety configuration as a normal protected
// exhaustion. Restore global capacity and introduce invalid per-blog config;
// this remains a real run error that diagnostics/operator must fix.
process.env.AI_DAILY_CALL_LIMIT = "20";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "abc";
const invalidConfigResult = await runGarden(globalBlog.id, { force: true });
if (invalidConfigResult[0]?.status !== "error") {
  throw new Error(`invalid budget configuration was incorrectly downgraded to protected skip: ${JSON.stringify(invalidConfigResult)}`);
}
if (editorialErrors(globalBlog.id) !== 1) {
  throw new Error(`invalid configuration did not remain visible as one editorial error: ${editorialErrors(globalBlog.id)}`);
}
if (aiBudgetStatus().calls !== 1) throw new Error("invalid preflight config unexpectedly consumed an AI call");

db.close();
console.log(JSON.stringify({
  ok: true,
  perBlogExhaustionIsProtectedSkip: true,
  globalExhaustionIsProtectedSkip: true,
  protectedSkipDoesNotConsumeAiCall: true,
  protectedSkipDoesNotAdvanceLastRun: true,
  repeatedProtectedStateIsLogDeduped: true,
  reasonChangeCreatesTransitionLog: true,
  recoveryThenSameReasonReentryCreatesTransitionLog: true,
  newBudgetDayCreatesTransitionLog: true,
  malformedConfigRemainsError: true,
}));
