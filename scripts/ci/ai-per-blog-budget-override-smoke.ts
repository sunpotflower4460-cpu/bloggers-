import Database from "better-sqlite3";
import { rmSync } from "node:fs";

const dbPath = ".ci/ai-per-blog-budget-override.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "100";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "3";

const { blogAiUsageScope, withAiUsageScope } = await import("../../src/lib/ai-usage-context");
const {
  blogAiDailyCallLimitOverride,
  setBlogAiDailyCallLimitOverride,
} = await import("../../src/lib/ai-budget-overrides");
const {
  aiBudgetStatus,
  aiPerBlogBudgetStatus,
  aiPerBlogDailyCallLimit,
  reserveAiCall,
} = await import("../../src/lib/ai-budget");

const scopeA = blogAiUsageScope("garden-a", "Garden A");
const scopeB = blogAiUsageScope("garden-b", "Garden B");
const scopeC = blogAiUsageScope("garden-c", "Garden C");

setBlogAiDailyCallLimitOverride("garden-a", 1);
setBlogAiDailyCallLimitOverride("garden-c", 4);
if (blogAiDailyCallLimitOverride("garden-a") !== 1 || blogAiDailyCallLimitOverride("garden-b") !== null) {
  throw new Error("override persistence is wrong");
}
if (aiPerBlogDailyCallLimit(scopeA.scopeKey) !== 1 || aiPerBlogDailyCallLimit(scopeB.scopeKey) !== 3 || aiPerBlogDailyCallLimit(scopeC.scopeKey) !== 4) {
  throw new Error("effective override/default limit resolution is wrong");
}

await withAiUsageScope(scopeA, async () => {
  reserveAiCall("primary:model-a");
  let blocked = false;
  try { reserveAiCall("fallback:model-a"); } catch (error) { blocked = String(error).includes("(1/1)"); }
  if (!blocked) throw new Error("Garden A override did not block at 1/1");
});

await withAiUsageScope(scopeB, async () => {
  reserveAiCall("primary:model-b");
  reserveAiCall("economy:model-b");
});

await withAiUsageScope(scopeC, async () => {
  reserveAiCall("primary:model-c");
  reserveAiCall("fallback:model-c");
  reserveAiCall("economy:model-c");
  reserveAiCall("primary:model-c-2");
  let blocked = false;
  try { reserveAiCall("fallback:model-c-2"); } catch (error) { blocked = String(error).includes("(4/4)"); }
  if (!blocked) throw new Error("Garden C override did not allow 4 then block at 4/4");
});

let status = aiPerBlogBudgetStatus();
if (!status.configured || status.limit !== 3 || status.overrideCount !== 2) {
  throw new Error(`mixed budget status metadata is wrong: ${JSON.stringify(status)}`);
}
const rowA = status.scopes.find((row) => row.scopeKey === scopeA.scopeKey);
const rowB = status.scopes.find((row) => row.scopeKey === scopeB.scopeKey);
const rowC = status.scopes.find((row) => row.scopeKey === scopeC.scopeKey);
if (!rowA || rowA.limit !== 1 || rowA.limitSource !== "override" || !rowA.exhausted) throw new Error(`Garden A status wrong: ${JSON.stringify(rowA)}`);
if (!rowB || rowB.limit !== 3 || rowB.limitSource !== "default" || rowB.exhausted) throw new Error(`Garden B status wrong: ${JSON.stringify(rowB)}`);
if (!rowC || rowC.limit !== 4 || rowC.limitSource !== "override" || !rowC.exhausted) throw new Error(`Garden C status wrong: ${JSON.stringify(rowC)}`);

// Clearing an override means INHERIT the environment default, not unlimited.
setBlogAiDailyCallLimitOverride("garden-a", null);
if (blogAiDailyCallLimitOverride("garden-a") !== null || aiPerBlogDailyCallLimit(scopeA.scopeKey) !== 3) {
  throw new Error("clearing Garden A override did not restore the shared default");
}
await withAiUsageScope(scopeA, async () => {
  reserveAiCall("primary:model-a-2");
  reserveAiCall("primary:model-a-3");
  let blocked = false;
  try { reserveAiCall("primary:model-a-4"); } catch (error) { blocked = String(error).includes("(3/3)"); }
  if (!blocked) throw new Error("Garden A did not inherit the 3-call shared default after override removal");
});

// A global default can be disabled while an explicit blog override remains active.
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "";
if (aiPerBlogDailyCallLimit(scopeB.scopeKey) !== null || aiPerBlogDailyCallLimit(scopeC.scopeKey) !== 4) {
  throw new Error("override-only mode did not preserve Garden C while releasing Garden B");
}
status = aiPerBlogBudgetStatus();
if (!status.configured || status.limit !== null || status.overrideCount !== 1) {
  throw new Error(`override-only status is wrong: ${JSON.stringify(status)}`);
}
if (status.scopes.some((row) => row.scopeKey === scopeB.scopeKey)) {
  throw new Error("Garden B remained capped after both its override and the shared default were absent");
}
const overrideOnlyC = status.scopes.find((row) => row.scopeKey === scopeC.scopeKey);
if (!overrideOnlyC || overrideOnlyC.limit !== 4 || overrideOnlyC.limitSource !== "override") {
  throw new Error(`Garden C override-only status is wrong: ${JSON.stringify(overrideOnlyC)}`);
}
await withAiUsageScope(scopeB, async () => {
  reserveAiCall("primary:model-b-3");
  reserveAiCall("primary:model-b-4");
});

// Persisted corruption must fail closed instead of silently becoming unlimited.
const rawDb = new Database(dbPath);
rawDb.prepare(`INSERT INTO blog_ai_budget_overrides (blog_id,daily_call_limit,updated_at)
  VALUES ('garden-a',0,datetime('now'))
  ON CONFLICT(blog_id) DO UPDATE SET daily_call_limit=0,updated_at=datetime('now')`).run();
rawDb.close();
let corruptBlocked = false;
await withAiUsageScope(scopeA, async () => {
  try { reserveAiCall("primary:corrupt"); } catch (error) { corruptBlocked = String(error).includes("between 1 and 100000"); }
});
if (!corruptBlocked) throw new Error("corrupt persisted override did not fail closed");

const global = aiBudgetStatus();
if (global.calls !== 11) {
  throw new Error(`blocked reservations unexpectedly consumed the global budget: ${global.calls}`);
}

console.log(JSON.stringify({
  ok: true,
  sharedDefault: 3,
  overrideAInitial: 1,
  overrideC: 4,
  clearedOverrideInheritsDefault: true,
  overrideOnlyMode: true,
  corruptOverrideFailsClosed: true,
  globalCalls: global.calls,
}));
