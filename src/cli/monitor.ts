import { runOperationalMonitor } from "../lib/ops-monitor";

try {
  const result = await runOperationalMonitor();
  console.log(JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
  if (result.notificationFailures > 0) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
