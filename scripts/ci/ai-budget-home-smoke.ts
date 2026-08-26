import { readFileSync, rmSync } from "node:fs";

const dbPath = ".ci/ai-budget-home.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
process.env.DATABASE_PATH = dbPath;

const { globalAiBudgetProtection, globalAiBudgetWarning } = await import("../../src/lib/ai-budget-home");

const base = {
  dayKey: "2026-08-26",
  timezone: "Asia/Tokyo",
  calls: 7,
  callLimit: 10,
  inputTokens: 300,
  outputTokens: 499,
  totalTokens: 799,
  tokenLimit: 1000,
  exhausted: false,
  utilization: 0.799,
};

if (globalAiBudgetProtection(base) !== null || globalAiBudgetWarning(base) !== null) {
  throw new Error("sub-80% global AI budget must not render warning or protection");
}

const callWarning = globalAiBudgetWarning({ ...base, calls: 8, utilization: 0.8 });
if (!callWarning || callWarning.reason !== "calls" || callWarning.reasonLabel !== "call残量注意" || callWarning.utilizationPercent !== 80) {
  throw new Error(`80% call warning was not classified correctly: ${JSON.stringify(callWarning)}`);
}

const tokenWarning = globalAiBudgetWarning({ ...base, totalTokens: 800, utilization: 0.8 });
if (!tokenWarning || tokenWarning.reason !== "tokens" || tokenWarning.reasonLabel !== "token残量注意") {
  throw new Error(`80% token warning was not classified correctly: ${JSON.stringify(tokenWarning)}`);
}

const combinedWarning = globalAiBudgetWarning({ ...base, calls: 8, totalTokens: 990, utilization: 0.99 });
if (!combinedWarning || combinedWarning.reason !== "calls-and-tokens" || combinedWarning.reasonLabel !== "call・token残量注意" || combinedWarning.utilizationPercent !== 99) {
  throw new Error(`combined near-limit warning was not classified correctly: ${JSON.stringify(combinedWarning)}`);
}

const calls = globalAiBudgetProtection({ ...base, calls: 10, exhausted: true, utilization: 1 });
if (!calls || calls.reason !== "calls" || calls.reasonLabel !== "call上限" || calls.calls !== 10 || calls.callLimit !== 10) {
  throw new Error(`call exhaustion was not classified correctly: ${JSON.stringify(calls)}`);
}
if (globalAiBudgetWarning({ ...base, calls: 10, exhausted: true, utilization: 1 }) !== null) {
  throw new Error("100% call hard-cap must replace, not coexist with, home warning");
}

const tokens = globalAiBudgetProtection({ ...base, totalTokens: 1000, exhausted: true, utilization: 1 });
if (!tokens || tokens.reason !== "tokens" || tokens.reasonLabel !== "token上限" || tokens.totalTokens !== 1000 || tokens.tokenLimit !== 1000) {
  throw new Error(`token exhaustion was not classified correctly: ${JSON.stringify(tokens)}`);
}

const both = globalAiBudgetProtection({ ...base, calls: 11, totalTokens: 1200, exhausted: true, utilization: 1.2 });
if (!both || both.reason !== "calls-and-tokens" || both.reasonLabel !== "call上限・token上限") {
  throw new Error(`combined exhaustion was not classified correctly: ${JSON.stringify(both)}`);
}
if (both.dayKey !== "2026-08-26" || both.timezone !== "Asia/Tokyo") {
  throw new Error(`budget day/timezone were not preserved: ${JSON.stringify(both)}`);
}

const homeSource = readFileSync("src/app/page.tsx", "utf8");
for (const required of [
  "const globalBudget = globalAiBudgetProtection();",
  "const globalBudgetWarning = globalAiBudgetWarning();",
  "庭全体のAI生成を保護停止",
  "AI予算の残りが少なくなっています",
  "まだhard capには到達していないため、ブログは停止していません。",
  "庭全体AI上限で保護停止",
  "AI予算を健康診断で確認",
  "const aiProtected = Boolean(globalBudget || budgetIncident);",
]) {
  if (!homeSource.includes(required)) throw new Error(`home is not wired to F-045/F-047: missing ${required}`);
}
if (homeSource.includes("Boolean(globalBudget || globalBudgetWarning || budgetIncident)")) {
  throw new Error("F-047 warning must not make blog cards look protected/stopped");
}

console.log(JSON.stringify({
  ok: true,
  sub80Hidden: true,
  warningAt80Percent: true,
  warningAt99Percent: true,
  warningAndHardCapMutuallyExclusive: true,
  callExhaustionVisible: true,
  tokenExhaustionVisible: true,
  combinedExhaustionVisible: true,
  warningDoesNotStopBlogCards: true,
  budgetWindowPreserved: true,
  homeWiringVerified: true,
}));
