import { rmSync } from "node:fs";

const dbPath = ".ci/ai-per-blog-budget.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "20";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "3";

const { blogAiUsageScope, withAiUsageScope } = await import("../../src/lib/ai-usage-context");
const { aiBudgetStatus, aiPerBlogBudgetStatus, reserveAiCall } = await import("../../src/lib/ai-budget");

const blogA = blogAiUsageScope("blog-a", "Garden A");
const blogB = blogAiUsageScope("blog-b", "Garden B");

await withAiUsageScope(blogA, async () => {
  reserveAiCall("primary:model-a");
  reserveAiCall("fallback:model-b");
  reserveAiCall("economy:model-c");

  let blocked = false;
  try {
    reserveAiCall("primary:model-a");
  } catch (error) {
    blocked = String(error).includes("per-blog daily call budget exhausted")
      && String(error).includes("Garden A")
      && String(error).includes("3/3");
  }
  if (!blocked) throw new Error("Garden A fourth call was not blocked by the per-blog cap");
});

// A rejected reservation must not consume the shared/global slot.
if (aiBudgetStatus().calls !== 3) {
  throw new Error(`blocked per-blog request changed global call count: ${aiBudgetStatus().calls}`);
}

// Another blog has an independent allowance even though Garden A is exhausted.
await withAiUsageScope(blogB, async () => {
  reserveAiCall("primary:model-a");
});
if (aiBudgetStatus().calls !== 4) throw new Error(`Garden B did not receive an independent slot: ${aiBudgetStatus().calls}`);

// F-038 intentionally scopes the blast-radius cap to blog:<id>. System work
// remains governed by the existing global budget only.
reserveAiCall("primary:system-model");
if (aiBudgetStatus().calls !== 5) throw new Error("system/unattributed call was incorrectly blocked by per-blog cap");

const status = aiPerBlogBudgetStatus();
if (!status.configured || status.limit !== 3) throw new Error(`wrong per-blog budget status: ${JSON.stringify(status)}`);
const a = status.scopes.find((row) => row.scopeKey === "blog:blog-a");
const b = status.scopes.find((row) => row.scopeKey === "blog:blog-b");
if (!a || a.calls !== 3 || !a.exhausted || a.utilization !== 1) {
  throw new Error(`Garden A status is wrong: ${JSON.stringify(a)}`);
}
if (!b || b.calls !== 1 || b.exhausted || b.utilization !== 1 / 3) {
  throw new Error(`Garden B status is wrong: ${JSON.stringify(b)}`);
}
if (status.scopes.some((row) => row.scopeKey === "system/unattributed")) {
  throw new Error("system/unattributed leaked into per-blog cap status");
}

// Invalid optional configuration fails closed for blog calls and must not
// silently become an unlimited blog cap. It also must not consume a slot.
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "abc";
const beforeInvalid = aiBudgetStatus().calls;
await withAiUsageScope(blogB, async () => {
  let rejected = false;
  try {
    reserveAiCall("primary:model-a");
  } catch (error) {
    rejected = String(error).includes("AI_PER_BLOG_DAILY_CALL_LIMIT");
  }
  if (!rejected) throw new Error("invalid per-blog cap did not reject a blog-scoped reservation");
});
if (aiBudgetStatus().calls !== beforeInvalid) throw new Error("invalid cap rejection consumed global budget");

// The optional blog cap is not a system-wide configuration kill-switch.
reserveAiCall("primary:system-after-invalid-config");
if (aiBudgetStatus().calls !== beforeInvalid + 1) {
  throw new Error("invalid per-blog config incorrectly blocked system/unattributed work");
}

// Empty means explicitly disabled. Garden A may resume, while the global
// budget remains the ultimate ceiling.
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "";
await withAiUsageScope(blogA, async () => {
  reserveAiCall("primary:model-a");
});
if (aiBudgetStatus().calls !== beforeInvalid + 2) throw new Error("disabled per-blog cap still blocked Garden A");
const disabled = aiPerBlogBudgetStatus();
if (disabled.configured || disabled.limit !== null || disabled.scopes.length !== 0) {
  throw new Error(`disabled per-blog status is misleading: ${JSON.stringify(disabled)}`);
}

console.log(JSON.stringify({
  ok: true,
  gardenA: { calls: a.calls, exhausted: a.exhausted },
  gardenB: { calls: b.calls, exhausted: b.exhausted },
  globalCalls: aiBudgetStatus().calls,
  invalidConfigIsolatedFromSystem: true,
  disabledAllowsBlogCalls: true,
}));
