import { rmSync } from "node:fs";

const dbPath = ".ci/ai-cost-alert.sqlite";
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
});
delete process.env.ALERT_WEBHOOK_URL;
delete process.env.AI_ESTIMATED_DAILY_COST_WARN;
delete process.env.AI_ESTIMATED_30D_COST_WARN;

const Database = (await import("better-sqlite3")).default;
const { recordAiUsage, reserveAiCall } = await import("../../src/lib/ai-budget");
const { aiCostThresholds, reconcileAiCostThresholdIncident } = await import("../../src/lib/ai-cost-alert");

let result = await reconcileAiCostThresholdIncident();
if (result.enabled) throw new Error("cost-threshold monitoring should be disabled when no threshold is configured");

process.env.AI_ESTIMATED_DAILY_COST_WARN = "0.50";
reserveAiCall("primary:model-a");
recordAiUsage({ input_tokens: 100_000, output_tokens: 50_000, total_tokens: 150_000 }, "primary:model-a");

result = await reconcileAiCostThresholdIncident();
if (!result.enabled || !result.exceeded || !result.observable) {
  throw new Error(`daily cost threshold did not trigger: ${JSON.stringify(result)}`);
}

let db = new Database(dbPath, { readonly: true });
let incident = db.prepare("SELECT status,severity,detail,resolved_at FROM operational_incidents WHERE code='ai-estimated-cost-threshold' AND scope='system'").get() as
  | { status: string; severity: string; detail: string; resolved_at: string | null }
  | undefined;
let count = Number((db.prepare("SELECT COUNT(*) n FROM operational_incidents WHERE code='ai-estimated-cost-threshold' AND scope='system'").get() as { n: number }).n);
db.close();
if (!incident || incident.status !== "open" || incident.severity !== "warning" || count !== 1) {
  throw new Error(`threshold incident was not opened once: ${JSON.stringify({ incident, count })}`);
}

await reconcileAiCostThresholdIncident();
db = new Database(dbPath, { readonly: true });
count = Number((db.prepare("SELECT COUNT(*) n FROM operational_incidents WHERE code='ai-estimated-cost-threshold' AND scope='system'").get() as { n: number }).n);
db.close();
if (count !== 1) throw new Error("active cost-threshold incident duplicated");

// Make the visible estimate lower than a raised threshold, but deliberately add
// one call without provider usage. The open incident must NOT be called recovered.
reserveAiCall("primary:model-a");
process.env.AI_ESTIMATED_DAILY_COST_WARN = "1.00";
result = await reconcileAiCostThresholdIncident();
if (result.exceeded) throw new Error("visible estimate should be below the raised daily threshold");
db = new Database(dbPath, { readonly: true });
incident = db.prepare("SELECT status,detail,resolved_at FROM operational_incidents WHERE code='ai-estimated-cost-threshold' AND scope='system'").get() as
  | { status: string; detail: string; resolved_at: string | null }
  | undefined;
db.close();
if (!incident || incident.status !== "open" || !incident.detail.includes("coverageが不完全")) {
  throw new Error(`incomplete coverage incorrectly closed a threshold incident: ${JSON.stringify(incident)}`);
}

// The missing call later receives usage, restoring complete coverage. The total
// remains below USD 1.00, so only now may the incident close.
recordAiUsage({ input_tokens: 10_000, output_tokens: 0, total_tokens: 10_000 }, "primary:model-a");
result = await reconcileAiCostThresholdIncident();
if (result.exceeded) throw new Error("complete estimate should remain below the raised threshold");
db = new Database(dbPath, { readonly: true });
incident = db.prepare("SELECT status,detail,resolved_at FROM operational_incidents WHERE code='ai-estimated-cost-threshold' AND scope='system'").get() as
  | { status: string; detail: string; resolved_at: string | null }
  | undefined;
db.close();
if (!incident || incident.status !== "closed" || !incident.resolved_at) {
  throw new Error(`complete below-threshold coverage did not close incident: ${JSON.stringify(incident)}`);
}

// 30-day projection is an independent operator warning signal. Current daily
// estimate is roughly USD 0.62, so one observed day projects to ~USD 18.6.
delete process.env.AI_ESTIMATED_DAILY_COST_WARN;
process.env.AI_ESTIMATED_30D_COST_WARN = "10";
result = await reconcileAiCostThresholdIncident();
if (!result.exceeded) throw new Error("30-day projected cost threshold did not trigger");
db = new Database(dbPath, { readonly: true });
incident = db.prepare("SELECT status,severity FROM operational_incidents WHERE code='ai-estimated-cost-threshold' AND scope='system'").get() as
  | { status: string; severity: string }
  | undefined;
db.close();
if (!incident || incident.status !== "open" || incident.severity !== "warning") {
  throw new Error(`30-day projection did not reopen warning incident: ${JSON.stringify(incident)}`);
}

// Removing all thresholds explicitly disables monitoring and closes the incident
// without claiming that spend itself became lower.
delete process.env.AI_ESTIMATED_30D_COST_WARN;
result = await reconcileAiCostThresholdIncident();
if (result.enabled) throw new Error("threshold monitoring did not disable after configuration removal");
db = new Database(dbPath, { readonly: true });
incident = db.prepare("SELECT status,detail FROM operational_incidents WHERE code='ai-estimated-cost-threshold' AND scope='system'").get() as
  | { status: string; detail: string }
  | undefined;
db.close();
if (!incident || incident.status !== "closed" || !incident.detail.includes("無効化")) {
  throw new Error(`disabling threshold monitoring did not close explicitly: ${JSON.stringify(incident)}`);
}

// Invalid thresholds fail closed.
process.env.AI_ESTIMATED_DAILY_COST_WARN = "-1";
let invalidRejected = false;
try {
  aiCostThresholds();
} catch (error) {
  invalidRejected = String(error).includes("finite positive number");
}
if (!invalidRejected) throw new Error("negative cost warning threshold was accepted");

process.env.AI_ESTIMATED_DAILY_COST_WARN = "NaN";
invalidRejected = false;
try {
  aiCostThresholds();
} catch (error) {
  invalidRejected = String(error).includes("finite positive number");
}
if (!invalidRejected) throw new Error("non-finite cost warning threshold was accepted");

console.log(JSON.stringify({ ok: true, finalIncident: incident }));
