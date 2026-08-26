import { runGarden } from "../lib/engine";
import { pingExternalHeartbeat } from "../lib/external-heartbeat";
import { heartbeat } from "../lib/ops-monitor";

heartbeat("worker", { phase: "start" });
try {
  const results = await runGarden(process.argv[2]);
  heartbeat("worker", { phase: "complete", results: results.length });
  const external = await pingExternalHeartbeat("worker");
  if (external.configured && !external.delivered) {
    console.error(`[worker] external dead-man heartbeat delivery failed: ${external.detail || "unknown error"}`);
  }
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    results,
    externalHeartbeat: { configured: external.configured, delivered: external.delivered },
  }, null, 2));
} catch (error) {
  heartbeat("worker", { phase: "error" });
  throw error;
}
