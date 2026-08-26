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
const { createBlog, getBlog } = await import("../../src/lib/db");
const { blogAiUsageScope, withAiUsageScope } = await import("../../src/lib/ai-usage-context");
const { aiBudgetStatus, reserveAiCall } = await import("../../src/lib/ai-budget");
const { runGarden } = await import("../../src/lib/engine");

function createTestBlog(name: string) {
  return createBlog({
    name,
    niche: "CI budget protection",
    platform: "wordpress",
    siteUrl: "https://example.invalid",
    keywords: ["ci"],
    feeds: [],
    credentialsCipher: encryptJson({}),
    publishMode: "auto",
    cadenceHours: 24,
    dailyLimit: 1,
    language: "ja",
    timezone: "UTC",
    ga4PropertyId: null,
    searchConsoleSiteUrl: null,
    active: true,
  });
}

const perBlog = createTestBlog("Per Blog Protected Garden");
const globalBlog = createTestBlog("Global Protected Garden");

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
  return db.prepare("SELECT message,meta_json FROM run_logs WHERE blog_id=? AND kind='execution' AND status='ok' ORDER BY id DESC")
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

// Now make the already-consumed single call equal the GLOBAL limit, while
// disabling the per-blog layer for the second blog. It must also protected-skip.
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
  malformedConfigRemainsError: true,
}));
