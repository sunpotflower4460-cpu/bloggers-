import { rmSync } from "node:fs";

const dbPath = ".ci/ai-cost.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "100";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PRICE_CURRENCY = "USD";
delete process.env.AI_PRICE_TABLE_JSON;

const Database = (await import("better-sqlite3")).default;

// Simulate the pre-metered_calls F-032 development schema so the smoke also
// proves the additive migration works for an existing database.
{
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ai_usage_model_daily (
      day_key TEXT NOT NULL,
      model_key TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(day_key, model_key)
    );
  `);
  db.close();
}

const { aiUsageByModel, recordAiUsage, reserveAiCall } = await import("../../src/lib/ai-budget");
const { aiCostEstimate, aiPriceTable } = await import("../../src/lib/ai-cost");

{
  const db = new Database(dbPath, { readonly: true });
  const columns = db.prepare("PRAGMA table_info(ai_usage_model_daily)").all() as Array<{ name: string }>;
  db.close();
  if (!columns.some((column) => column.name === "metered_calls")) {
    throw new Error("existing ai_usage_model_daily schema was not migrated with metered_calls");
  }
}

// Two primary calls, but only one returns usage: this is the mixed case that a
// simple daily token aggregate cannot detect without metered_calls.
reserveAiCall("primary:model-a");
recordAiUsage({ input_tokens: 100_000, output_tokens: 50_000, total_tokens: 170_000 }, "primary:model-a");
reserveAiCall("primary:model-a");

reserveAiCall("economy:model-b");
recordAiUsage({ input_tokens: 200_000, output_tokens: 20_000, total_tokens: 220_000 }, "economy:model-b");

reserveAiCall("fallback:model-c");
recordAiUsage({ input_tokens: 10_000, output_tokens: 5_000, total_tokens: 15_000 }, "fallback:model-c");

const usage = aiUsageByModel(7);
const primary = usage.find((row) => row.modelKey === "primary:model-a");
const economy = usage.find((row) => row.modelKey === "economy:model-b");
const fallback = usage.find((row) => row.modelKey === "fallback:model-c");
if (!primary || primary.calls !== 2 || primary.meteredCalls !== 1) {
  throw new Error(`mixed metered/unmetered primary calls were not preserved: ${JSON.stringify(primary)}`);
}
if (!economy || economy.calls !== 1 || economy.meteredCalls !== 1) throw new Error("economy usage was not tracked");
if (!fallback || fallback.calls !== 1 || fallback.meteredCalls !== 1) throw new Error("fallback usage was not tracked");

const withoutPrices = aiCostEstimate();
if (withoutPrices.configured) throw new Error("cost estimate should remain unconfigured without operator pricing");

process.env.AI_PRICE_TABLE_JSON = JSON.stringify({
  "primary:model-a": { inputPerMillion: 2, outputPerMillion: 8 },
  "economy:model-b": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
});

const estimate = aiCostEstimate();
const close = (actual: number, expected: number, tolerance = 1e-9) => Math.abs(actual - expected) <= tolerance;

// primary = 0.1*2 + 0.05*8 = 0.60
// economy = 0.2*0.5 + 0.02*1.5 = 0.13
if (!close(estimate.todayEstimatedCost, 0.73)) throw new Error(`unexpected today estimate ${estimate.todayEstimatedCost}`);
if (!close(estimate.last7dEstimatedCost, 0.73)) throw new Error(`unexpected 7d estimate ${estimate.last7dEstimatedCost}`);
if (estimate.observedDays !== 1) throw new Error(`expected one observed day, got ${estimate.observedDays}`);
if (!close(estimate.projected30dCost, 21.9)) throw new Error(`unexpected 30d projection ${estimate.projected30dCost}`);

// Reported total = 170k + 220k + 15k = 405k.
// Priceable input/output categories = 150k + 220k = 370k.
const expectedCoverage = (370_000 / 405_000) * 100;
if (estimate.coveragePercent === null || !close(estimate.coveragePercent, expectedCoverage, 1e-7)) {
  throw new Error(`unexpected pricing coverage ${estimate.coveragePercent}`);
}
if (estimate.unpricedTokens !== 35_000) throw new Error(`expected 35000 estimate-gap tokens, got ${estimate.unpricedTokens}`);
if (estimate.unmeteredCalls !== 1) throw new Error(`mixed missing-usage call was hidden: ${estimate.unmeteredCalls}`);
if (!estimate.unpricedModelKeys.includes("fallback:model-c")) throw new Error("unpriced fallback model was not surfaced");
if (estimate.complete) throw new Error("partial pricing/usage coverage was incorrectly marked complete");

const primarySummary = estimate.models.find((row) => row.modelKey === "primary:model-a");
if (!primarySummary || primarySummary.calls !== 2 || primarySummary.meteredCalls !== 1 || !close(primarySummary.estimatedCost ?? -1, 0.6)) {
  throw new Error(`primary model summary is wrong: ${JSON.stringify(primarySummary)}`);
}
const fallbackSummary = estimate.models.find((row) => row.modelKey === "fallback:model-c");
if (!fallbackSummary || fallbackSummary.priceConfigured || fallbackSummary.estimatedCost !== null) {
  throw new Error(`unpriced model summary was hidden: ${JSON.stringify(fallbackSummary)}`);
}

// Provider usage is untrusted external data. Non-finite/negative counters must
// not reach SQLite as numbers, and absurd finite counters are bounded.
reserveAiCall("primary:invalid-usage");
recordAiUsage({ input_tokens: "Infinity", output_tokens: -5, total_tokens: Number.POSITIVE_INFINITY }, "primary:invalid-usage");
reserveAiCall("primary:huge-usage");
recordAiUsage({ input_tokens: 1e30, output_tokens: 0, total_tokens: 1e30 }, "primary:huge-usage");
const hardenedUsage = aiUsageByModel(7);
const invalidUsage = hardenedUsage.find((row) => row.modelKey === "primary:invalid-usage");
const hugeUsage = hardenedUsage.find((row) => row.modelKey === "primary:huge-usage");
if (!invalidUsage || invalidUsage.calls !== 1 || invalidUsage.meteredCalls !== 0 || invalidUsage.totalTokens !== 0) {
  throw new Error(`non-finite usage was not rejected conservatively: ${JSON.stringify(invalidUsage)}`);
}
if (!hugeUsage || hugeUsage.calls !== 1 || hugeUsage.meteredCalls !== 1 || hugeUsage.inputTokens !== 1_000_000_000 || hugeUsage.totalTokens !== 1_000_000_000) {
  throw new Error(`extreme finite usage was not bounded safely: ${JSON.stringify(hugeUsage)}`);
}

// Configuration validation must fail closed instead of silently ignoring a bad
// operator price table.
process.env.AI_PRICE_CURRENCY = "US";
let badCurrencyRejected = false;
try {
  aiPriceTable();
} catch (error) {
  badCurrencyRejected = String(error).includes("3-letter currency code");
}
if (!badCurrencyRejected) throw new Error("invalid AI_PRICE_CURRENCY was accepted");

process.env.AI_PRICE_CURRENCY = "USD";
process.env.AI_PRICE_TABLE_JSON = JSON.stringify({
  "primary:model-a": { inputPerMillion: -1, outputPerMillion: 8 },
});
let badPriceRejected = false;
try {
  aiPriceTable();
} catch (error) {
  badPriceRejected = String(error).includes("finite non-negative number");
}
if (!badPriceRejected) throw new Error("negative operator price was accepted");

console.log(JSON.stringify({
  ok: true,
  todayEstimatedCost: estimate.todayEstimatedCost,
  projected30dCost: estimate.projected30dCost,
  coveragePercent: estimate.coveragePercent,
  unmeteredCalls: estimate.unmeteredCalls,
  unpricedModelKeys: estimate.unpricedModelKeys,
}));
