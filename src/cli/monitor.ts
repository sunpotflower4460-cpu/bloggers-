import { reconcileAiBudgetIncident } from "../lib/ai-budget-alert";
import { reconcileAiCostThresholdIncident } from "../lib/ai-cost-alert";
import { reconcileAiPerBlogBudgetIncidents } from "../lib/ai-per-blog-budget-alert";
import { reconcileAiRoutingIncidents } from "../lib/ai-routing-alert";
import { reconcileExternalHeartbeatIncidents } from "../lib/external-heartbeat-alert";
import { runOperationalMonitor } from "../lib/ops-monitor";

try {
  const result = await runOperationalMonitor();
  const aiBudget = await reconcileAiBudgetIncident();
  const aiPerBlogBudget = await reconcileAiPerBlogBudgetIncidents();
  const aiCost = await reconcileAiCostThresholdIncident();
  const aiRouting = await reconcileAiRoutingIncidents();
  const externalHeartbeat = await reconcileExternalHeartbeatIncidents();
  console.log(JSON.stringify({ at: new Date().toISOString(), ...result, aiBudget, aiPerBlogBudget, aiCost, aiRouting, externalHeartbeat }, null, 2));
  if (
    result.notificationFailures > 0
    || aiBudget.notificationFailure
    || aiPerBlogBudget.notificationFailures > 0
    || aiCost.notificationFailure
    || aiRouting.notificationFailures > 0
    || externalHeartbeat.notificationFailures > 0
  ) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
