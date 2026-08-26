import { rmSync } from "node:fs";

const dbPath = ".ci/ai-budget-home.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
process.env.DATABASE_PATH = dbPath;

const { globalAiBudgetProtection } = await import("../../src/lib/ai-budget-home");

const base = {
  dayKey: "2026-08-26",
  timezone: "Asia/Tokyo",
  calls: 4,
  callLimit: 5,
  inputTokens: 100,
  outputTokens: 200,
  totalTokens: 300,
  tokenLimit: 500,
  exhausted: false,
  utilization: 0.8,
};

if (globalAiBudgetProtection(base) !== null) {
  throw new Error("healthy global AI budget must not render a protection banner");
}

const calls = globalAiBudgetProtection({ ...base, calls: 5, exhausted: true, utilization: 1 });
if (!calls || calls.reason !== "calls" || calls.reasonLabel !== "call上限" || calls.calls !== 5 || calls.callLimit !== 5) {
  throw new Error(`call exhaustion was not classified correctly: ${JSON.stringify(calls)}`);
}

const tokens = globalAiBudgetProtection({ ...base, totalTokens: 500, exhausted: true, utilization: 1 });
if (!tokens || tokens.reason !== "tokens" || tokens.reasonLabel !== "token上限" || tokens.totalTokens !== 500 || tokens.tokenLimit !== 500) {
  throw new Error(`token exhaustion was not classified correctly: ${JSON.stringify(tokens)}`);
}

const both = globalAiBudgetProtection({ ...base, calls: 6, totalTokens: 700, exhausted: true, utilization: 1.4 });
if (!both || both.reason !== "calls-and-tokens" || both.reasonLabel !== "call上限・token上限") {
  throw new Error(`combined exhaustion was not classified correctly: ${JSON.stringify(both)}`);
}
if (both.dayKey !== "2026-08-26" || both.timezone !== "Asia/Tokyo") {
  throw new Error(`budget day/timezone were not preserved: ${JSON.stringify(both)}`);
}

console.log(JSON.stringify({
  ok: true,
  healthyHidden: true,
  callExhaustionVisible: true,
  tokenExhaustionVisible: true,
  combinedExhaustionVisible: true,
  budgetWindowPreserved: true,
}));
