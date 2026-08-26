import Database from "better-sqlite3";
import { readFileSync, rmSync } from "node:fs";

const dbPath = ".ci/ai-per-blog-budget-home-live.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "50";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "5";

const { blogAiUsageScope, withAiUsageScope } = await import("../../src/lib/ai-usage-context");
const { reserveAiCall } = await import("../../src/lib/ai-budget");
const { perBlogBudgetHomeSnapshot } = await import("../../src/lib/ai-per-blog-budget-home");

const scope = blogAiUsageScope("live-blog", "Live Garden");
const reserve = async () => withAiUsageScope(scope, async () => reserveAiCall("primary:live-model"));

await reserve();
await reserve();
await reserve();
let snapshot = perBlogBudgetHomeSnapshot();
if (snapshot.configError || snapshot.scopes.length !== 0) {
  throw new Error(`below-80 live state must be hidden: ${JSON.stringify(snapshot)}`);
}

await reserve();
snapshot = perBlogBudgetHomeSnapshot();
const near = snapshot.scopes.find((row) => row.scopeKey === "blog:live-blog");
if (!near || near.state !== "near-limit" || near.calls !== 4 || near.limit !== 5 || near.utilizationPercent !== 80) {
  throw new Error(`80% live state was not visible immediately: ${JSON.stringify(snapshot)}`);
}

// No alert reconciler has been imported or executed. The live home state must
// therefore be observable without depending on an operational incident row.
const db = new Database(dbPath, { readonly: true });
const incidentTable = db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='operational_incidents'").get() as { ok: number } | undefined;
db.close();
if (incidentTable) throw new Error("live home smoke unexpectedly created the incident table");

await reserve();
snapshot = perBlogBudgetHomeSnapshot();
const exhausted = snapshot.scopes.find((row) => row.scopeKey === "blog:live-blog");
if (!exhausted || exhausted.state !== "exhausted" || exhausted.calls !== 5 || exhausted.limit !== 5 || exhausted.utilizationPercent !== 100) {
  throw new Error(`100% live exhausted state was not visible immediately: ${JSON.stringify(snapshot)}`);
}

process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "abc";
const invalid = perBlogBudgetHomeSnapshot();
if (!invalid.configError || invalid.scopes.length !== 0 || !invalid.configured) {
  throw new Error(`malformed cap did not produce safe home fallback state: ${JSON.stringify(invalid)}`);
}
process.env.AI_PER_BLOG_DAILY_CALL_LIMIT = "5";

const homeSource = readFileSync("src/app/page.tsx", "utf8");
for (const required of [
  'perBlogBudgetHomeSnapshot',
  'const livePerBlogBudget = perBlogBudgetHomeSnapshot();',
  'const liveBudgetScopes = new Map',
  'livePerBlogBudget.configError',
  'liveBudgetScope?.state ?? null',
  'Boolean(globalBudget || currentBudgetState === "exhausted")',
  'currentBudgetState === "near-limit" && !globalBudget',
  'budgetIncident?.detail || currentBudgetDetail',
  'budgetWarning?.detail || currentBudgetDetail',
]) {
  if (!homeSource.includes(required)) throw new Error(`F-050 home wiring missing: ${required}`);
}
if (homeSource.includes('Boolean(globalBudget || currentBudgetState === "near-limit")')) {
  throw new Error("near-limit was incorrectly added to protected-state calculation");
}

console.log(JSON.stringify({
  ok: true,
  below80Hidden: true,
  nearLimitVisibleBeforeMonitor: true,
  exhaustedVisibleBeforeMonitor: true,
  noIncidentDependency: true,
  configErrorIsSafeFallback: true,
  persistentIncidentsAreEnrichmentOnlyWhenLiveIsValid: true,
}));
