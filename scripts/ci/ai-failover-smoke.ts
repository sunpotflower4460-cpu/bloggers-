import http from "node:http";
import { rmSync } from "node:fs";

const dbPath = ".ci/ai-failover.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_API_KEY = "ci-primary-key";
process.env.AI_MODEL = "ci-primary-model";
process.env.AI_PRIMARY_PROVIDER_LABEL = "ci-primary";
process.env.AI_FALLBACK_MODEL = "ci-fallback-model";
process.env.AI_FALLBACK_PROVIDER_LABEL = "ci-fallback";
process.env.AI_DAILY_CALL_LIMIT = "30";
process.env.AI_DAILY_TOKEN_LIMIT = "100000";
process.env.AI_BUDGET_TIMEZONE = "UTC";
delete process.env.AI_FALLBACK_API_KEY;
delete process.env.ALERT_WEBHOOK_URL;

let primaryMode: "retryable" | "healthy" | "auth" = "retryable";
let primaryRequests = 0;
let fallbackRequests = 0;

const server = http.createServer((req, res) => {
  if (req.url === "/primary/responses" && req.method === "POST") {
    primaryRequests += 1;
    if (primaryMode === "retryable") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "temporary upstream unavailable" } }));
      return;
    }
    if (primaryMode === "auth") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid credentials" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      output_text: JSON.stringify({ route: "primary" }),
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }));
    return;
  }

  if (req.url === "/fallback/responses" && req.method === "POST") {
    fallbackRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      output_text: JSON.stringify({ route: "fallback" }),
      usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
    }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind mock AI server");
const port = address.port;
process.env.AI_BASE_URL = `http://127.0.0.1:${port}/primary`;
process.env.AI_FALLBACK_BASE_URL = `http://127.0.0.1:${port}/fallback`;

try {
  const { aiJson } = await import("../../src/lib/ai");
  const { aiBudgetStatus } = await import("../../src/lib/ai-budget");
  const { aiRoutingStatus, resolveAiRoutes } = await import("../../src/lib/ai-routing");
  const { reconcileAiRoutingIncidents } = await import("../../src/lib/ai-routing-alert");
  const Database = (await import("better-sqlite3")).default;

  for (let i = 0; i < 3; i += 1) {
    const result = await aiJson<{ route: string }>("system", `retryable-${i}`);
    if (result.route !== "fallback") throw new Error("retryable primary failure did not use fallback");
  }

  if (primaryRequests !== 3 || fallbackRequests !== 3) {
    throw new Error(`unexpected bounded routing counts primary=${primaryRequests} fallback=${fallbackRequests}`);
  }
  const budgetAfterFallback = aiBudgetStatus();
  if (budgetAfterFallback.calls !== 6) {
    throw new Error(`primary + fallback must share call budget; got ${budgetAfterFallback.calls}`);
  }

  let routing = aiRoutingStatus();
  if (!routing.primaryDegraded || routing.fallbackSuccesses24h !== 3 || !routing.fallbackCurrentlyHealthy) {
    throw new Error(`routing degradation was not detected: ${JSON.stringify(routing)}`);
  }

  const db = new Database(dbPath);
  const created = new Date(Date.now() - 86400000).toISOString();
  db.prepare(`INSERT INTO blogs
    (id,name,niche,platform,site_url,keywords_json,feeds_json,credentials_cipher,publish_mode,cadence_hours,daily_limit,language,timezone,active,last_run_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "ci-ai-route-blog", "CI AI Route Blog", "test", "wordpress", "https://example.invalid", "[]", "[]", "unused", "auto", 24, 1, "ja", "Asia/Tokyo", 1, null, created,
    );
  db.close();

  await reconcileAiRoutingIncidents();
  let incidentDb = new Database(dbPath, { readonly: true });
  let incident = incidentDb.prepare("SELECT status,severity FROM operational_incidents WHERE code='ai-primary-degraded' AND scope='system'").get() as { status: string; severity: string } | undefined;
  incidentDb.close();
  if (!incident || incident.status !== "open" || incident.severity !== "warning") {
    throw new Error(`degraded primary incident was not opened as warning: ${JSON.stringify(incident)}`);
  }

  primaryMode = "healthy";
  const healthy = await aiJson<{ route: string }>("system", "primary recovered");
  if (healthy.route !== "primary") throw new Error("healthy primary unexpectedly used fallback");
  routing = aiRoutingStatus();
  if (routing.primaryDegraded) throw new Error("primary degradation did not clear after successful probe");
  await reconcileAiRoutingIncidents();
  incidentDb = new Database(dbPath, { readonly: true });
  incident = incidentDb.prepare("SELECT status,severity FROM operational_incidents WHERE code='ai-primary-degraded' AND scope='system'").get() as { status: string; severity: string } | undefined;
  incidentDb.close();
  if (!incident || incident.status !== "closed") throw new Error("primary recovery did not close incident");

  const fallbackBeforeAuth = fallbackRequests;
  primaryMode = "auth";
  let authFailed = false;
  try {
    await aiJson("system", "auth should not fail over");
  } catch (error) {
    authFailed = String(error).includes("401");
  }
  if (!authFailed) throw new Error("non-retryable 401 did not fail directly");
  if (fallbackRequests !== fallbackBeforeAuth) throw new Error("401 incorrectly triggered fallback");

  const safeFallbackBase = process.env.AI_FALLBACK_BASE_URL;
  process.env.AI_FALLBACK_BASE_URL = `http://127.0.0.2:${port}/fallback`;
  delete process.env.AI_FALLBACK_API_KEY;
  let crossHostRejected = false;
  try {
    resolveAiRoutes();
  } catch (error) {
    crossHostRejected = String(error).includes("AI_FALLBACK_API_KEY is required");
  }
  if (!crossHostRejected) throw new Error("cross-host fallback reused primary credential");
  process.env.AI_FALLBACK_API_KEY = "ci-dedicated-fallback-key";
  if (resolveAiRoutes().length !== 2) throw new Error("dedicated cross-host fallback key was not accepted");
  process.env.AI_FALLBACK_BASE_URL = safeFallbackBase;

  console.log(JSON.stringify({
    ok: true,
    primaryRequests,
    fallbackRequests,
    calls: aiBudgetStatus().calls,
    routing: aiRoutingStatus(),
  }));
} finally {
  server.close();
}
