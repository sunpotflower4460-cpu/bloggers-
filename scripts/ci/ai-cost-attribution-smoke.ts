import { rmSync } from "node:fs";

const dbPath = ".ci/ai-cost-attribution.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "100";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PRICE_CURRENCY = "USD";
process.env.AI_PRICE_TABLE_JSON = JSON.stringify({
  "primary:model-a": { inputPerMillion: 2, outputPerMillion: 8 },
  "economy:model-b": { inputPerMillion: 1, outputPerMillion: 2 },
  "primary:system-model": { inputPerMillion: 0.5, outputPerMillion: 0.5 },
  "primary:legacy-model": { inputPerMillion: 1, outputPerMillion: 1 },
});

const Database = (await import("better-sqlite3")).default;
const {
  aiUsageByModel,
  aiUsageByScope,
  recordAiUsage,
  reserveAiCall,
} = await import("../../src/lib/ai-budget");
const {
  blogAiUsageScope,
  currentAiUsageScope,
  withAiUsageScope,
} = await import("../../src/lib/ai-usage-context");
const { aiCostEstimate } = await import("../../src/lib/ai-cost");

const day = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

// Simulate one pre-F-035 usage row. It belongs in the global/model totals but
// there is deliberately no scope row because its originating blog is unknowable.
{
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_usage_daily
    (day_key,calls,input_tokens,output_tokens,total_tokens,last_model,updated_at)
    VALUES (?,1,20000,10000,30000,?,?)`).run(day, "primary:legacy-model", now);
  db.prepare(`INSERT INTO ai_usage_model_daily
    (day_key,model_key,calls,metered_calls,input_tokens,output_tokens,total_tokens,updated_at)
    VALUES (?,?,1,1,20000,10000,30000,?)`).run(day, "primary:legacy-model", now);
  db.close();
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const scopeA = blogAiUsageScope("blog-a-id", "Garden A");
const scopeB = blogAiUsageScope("blog-b-id", "Garden B");

// Interleave two asynchronous scopes on purpose. A process-global mutable label
// would contaminate these rows; AsyncLocalStorage.run() must keep them isolated.
await Promise.all([
  withAiUsageScope(scopeA, async () => {
    if (currentAiUsageScope().scopeKey !== scopeA.scopeKey) throw new Error("scope A was not active at start");
    reserveAiCall("primary:model-a");
    await delay(25);
    if (currentAiUsageScope().scopeKey !== scopeA.scopeKey) throw new Error("scope A was lost across await");
    recordAiUsage({ input_tokens: 100_000, output_tokens: 10_000, total_tokens: 110_000 }, "primary:model-a");
  }),
  withAiUsageScope(scopeB, async () => {
    await delay(5);
    if (currentAiUsageScope().scopeKey !== scopeB.scopeKey) throw new Error("scope B was not isolated");
    reserveAiCall("economy:model-b");
    recordAiUsage({ input_tokens: 50_000, output_tokens: 20_000, total_tokens: 70_000 }, "economy:model-b");
    await delay(10);
    if (currentAiUsageScope().scopeKey !== scopeB.scopeKey) throw new Error("scope B was lost across await");
    reserveAiCall("economy:model-b");
    recordAiUsage({ input_tokens: 20_000, output_tokens: 5_000, total_tokens: 25_000 }, "economy:model-b");
  }),
]);

// Outside a blog execution the scope must restore to the explicit system bucket.
if (currentAiUsageScope().scopeKey !== "system/unattributed") {
  throw new Error(`async scopes leaked into parent context: ${JSON.stringify(currentAiUsageScope())}`);
}
reserveAiCall("primary:system-model");
recordAiUsage({ input_tokens: 10_000, output_tokens: 10_000, total_tokens: 20_000 }, "primary:system-model");

const scoped = aiUsageByScope(7);
const byScope = new Map<string, typeof scoped>();
for (const row of scoped) {
  const rows = byScope.get(row.scopeKey) ?? [];
  rows.push(row);
  byScope.set(row.scopeKey, rows);
}

const rowsA = byScope.get(scopeA.scopeKey) ?? [];
const rowsB = byScope.get(scopeB.scopeKey) ?? [];
const systemRows = byScope.get("system/unattributed") ?? [];
if (rowsA.length !== 1 || rowsA[0].modelKey !== "primary:model-a" || rowsA[0].calls !== 1 || rowsA[0].meteredCalls !== 1) {
  throw new Error(`Garden A attribution is wrong: ${JSON.stringify(rowsA)}`);
}
if (rowsB.length !== 1 || rowsB[0].modelKey !== "economy:model-b" || rowsB[0].calls !== 2 || rowsB[0].meteredCalls !== 2) {
  throw new Error(`Garden B attribution is wrong: ${JSON.stringify(rowsB)}`);
}
if (systemRows.length !== 1 || systemRows[0].modelKey !== "primary:system-model" || systemRows[0].calls !== 1) {
  throw new Error(`system/unattributed attribution is wrong: ${JSON.stringify(systemRows)}`);
}
if (scoped.some((row) => row.modelKey === "primary:legacy-model")) {
  throw new Error("pre-F-035 legacy usage was fabricated into a scope");
}

const globalUsage = aiUsageByModel(7);
const globalCalls = globalUsage.reduce((sum, row) => sum + row.calls, 0);
const scopedCalls = scoped.reduce((sum, row) => sum + row.calls, 0);
if (globalCalls !== 5 || scopedCalls !== 4) {
  throw new Error(`unexpected global/scope call totals: global=${globalCalls} scoped=${scopedCalls}`);
}

const estimate = aiCostEstimate();
const close = (actual: number, expected: number, tolerance = 1e-9) => Math.abs(actual - expected) <= tolerance;
const gardenA = estimate.scopes.find((scope) => scope.scopeKey === scopeA.scopeKey);
const gardenB = estimate.scopes.find((scope) => scope.scopeKey === scopeB.scopeKey);
const system = estimate.scopes.find((scope) => scope.scopeKey === "system/unattributed");

// A = 0.1*2 + 0.01*8 = 0.28
// B = 0.07*1 + 0.025*2 = 0.12
// system = 0.01*0.5 + 0.01*0.5 = 0.01
// legacy global-only = 0.02*1 + 0.01*1 = 0.03
if (!gardenA || !close(gardenA.last7dEstimatedCost, 0.28) || !gardenA.complete) {
  throw new Error(`Garden A cost summary is wrong: ${JSON.stringify(gardenA)}`);
}
if (!gardenB || !close(gardenB.last7dEstimatedCost, 0.12) || !gardenB.complete) {
  throw new Error(`Garden B cost summary is wrong: ${JSON.stringify(gardenB)}`);
}
if (!system || !close(system.last7dEstimatedCost, 0.01) || !system.complete) {
  throw new Error(`system cost summary is wrong: ${JSON.stringify(system)}`);
}
if (!close(estimate.last7dEstimatedCost, 0.44)) {
  throw new Error(`global estimate no longer matches all usage: ${estimate.last7dEstimatedCost}`);
}
if (estimate.unattributedHistoricalCalls !== 1 || estimate.unattributedHistoricalTokens !== 30_000) {
  throw new Error(`legacy attribution gap was hidden: ${JSON.stringify({ calls: estimate.unattributedHistoricalCalls, tokens: estimate.unattributedHistoricalTokens })}`);
}
if (estimate.attributionCallCoveragePercent === null || !close(estimate.attributionCallCoveragePercent, 80)) {
  throw new Error(`call attribution coverage is wrong: ${estimate.attributionCallCoveragePercent}`);
}
const expectedTokenCoverage = (225_000 / 255_000) * 100;
if (estimate.attributionTokenCoveragePercent === null || !close(estimate.attributionTokenCoveragePercent, expectedTokenCoverage, 1e-7)) {
  throw new Error(`token attribution coverage is wrong: ${estimate.attributionTokenCoveragePercent}`);
}

console.log(JSON.stringify({
  ok: true,
  scopes: estimate.scopes.map((scope) => ({
    scope: scope.scopeLabel,
    calls: scope.calls,
    cost: scope.last7dEstimatedCost,
  })),
  attributionCallCoveragePercent: estimate.attributionCallCoveragePercent,
  attributionTokenCoveragePercent: estimate.attributionTokenCoveragePercent,
  unattributedHistoricalCalls: estimate.unattributedHistoricalCalls,
  unattributedHistoricalTokens: estimate.unattributedHistoricalTokens,
}));
