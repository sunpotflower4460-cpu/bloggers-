import { runGarden } from "../lib/engine";
import { heartbeat } from "../lib/ops-monitor";

heartbeat("worker", { phase: "start" });
try {
  const results = await runGarden(process.argv[2]);
  heartbeat("worker", { phase: "complete", results: results.length });
  console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
} catch (error) {
  heartbeat("worker", { phase: "error" });
  throw error;
}
