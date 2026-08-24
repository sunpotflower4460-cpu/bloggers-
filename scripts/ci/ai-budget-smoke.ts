import { aiBudgetStatus, recordAiUsage, reserveAiCall } from "../../src/lib/ai-budget";

const mode = process.env.TEST_AI_BUDGET_MODE || "calls";

if (mode === "calls") {
  reserveAiCall("ci-model");
  reserveAiCall("ci-model");
  const before = aiBudgetStatus();
  if (before.calls !== 2) throw new Error(`expected 2 calls, got ${before.calls}`);
  let blocked = false;
  try {
    reserveAiCall("ci-model");
  } catch (error) {
    blocked = String(error).includes("call budget exhausted");
  }
  if (!blocked) throw new Error("daily call limit did not block the third request");
}

if (mode === "tokens") {
  reserveAiCall("ci-model");
  recordAiUsage({ input_tokens: 140, output_tokens: 80, total_tokens: 220 }, "ci-model");
  const status = aiBudgetStatus();
  if (status.totalTokens !== 220) throw new Error(`expected 220 tokens, got ${status.totalTokens}`);
  let blocked = false;
  try {
    reserveAiCall("ci-model");
  } catch (error) {
    blocked = String(error).includes("token budget exhausted");
  }
  if (!blocked) throw new Error("daily token limit did not block the next request");
}

console.log(`AI budget smoke passed: ${mode}`);
