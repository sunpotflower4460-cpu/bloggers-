import http from "node:http";
import { rmSync } from "node:fs";

const dbPath = ".ci/ai-economy.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_API_KEY = "ci-primary-key";
process.env.AI_MODEL = "ci-primary-model";
process.env.AI_PRIMARY_PROVIDER_LABEL = "ci-primary";
process.env.AI_FALLBACK_MODEL = "ci-fallback-model";
process.env.AI_FALLBACK_PROVIDER_LABEL = "ci-fallback";
process.env.AI_ECONOMY_MODEL = "ci-economy-model";
process.env.AI_ECONOMY_PROVIDER_LABEL = "ci-economy";
process.env.AI_INTERNAL_ROUTE_POLICY = "economy";
process.env.AI_DAILY_CALL_LIMIT = "50";
process.env.AI_DAILY_TOKEN_LIMIT = "100000";
process.env.AI_BUDGET_TIMEZONE = "UTC";
delete process.env.AI_FALLBACK_API_KEY;
delete process.env.AI_ECONOMY_API_KEY;
delete process.env.ALERT_WEBHOOK_URL;

let economyMode: "healthy" | "retryable" | "fatal" | "malformed" = "healthy";
let primaryRequests = 0;
let fallbackRequests = 0;
let economyRequests = 0;

function success(res: http.ServerResponse, route: string) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    output_text: JSON.stringify({ route }),
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }));
}

const server = http.createServer((req, res) => {
  if (req.url === "/primary/responses" && req.method === "POST") {
    primaryRequests += 1;
    success(res, "primary");
    return;
  }
  if (req.url === "/fallback/responses" && req.method === "POST") {
    fallbackRequests += 1;
    success(res, "fallback");
    return;
  }
  if (req.url === "/economy/responses" && req.method === "POST") {
    economyRequests += 1;
    if (economyMode === "retryable") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "economy temporarily unavailable" } }));
      return;
    }
    if (economyMode === "fatal") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "economy credential rejected" } }));
      return;
    }
    if (economyMode === "malformed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: "not valid json", usage: { total_tokens: 3 } }));
      return;
    }
    success(res, "economy");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind economy mock AI server");
const port = address.port;
process.env.AI_BASE_URL = `http://127.0.0.1:${port}/primary`;
process.env.AI_FALLBACK_BASE_URL = `http://127.0.0.1:${port}/fallback`;
process.env.AI_ECONOMY_BASE_URL = `http://127.0.0.1:${port}/economy`;

try {
  const { aiJson, aiJsonWithMeta } = await import("../../src/lib/ai");
  const { aiBudgetStatus } = await import("../../src/lib/ai-budget");
  const { aiRoutingStatus, resolveEconomyRoute } = await import("../../src/lib/ai-routing");
  const { reconcileAiRoutingIncidents } = await import("../../src/lib/ai-routing-alert");
  const Database = (await import("better-sqlite3")).default;

  const internal = await aiJson<{ route: string }>("system", "internal planning");
  if (internal.route !== "economy") throw new Error(`internal task did not prefer economy: ${JSON.stringify(internal)}`);
  if (economyRequests !== 1 || primaryRequests !== 0 || fallbackRequests !== 0) {
    throw new Error(`healthy economy routing made unexpected calls: economy=${economyRequests} primary=${primaryRequests} fallback=${fallbackRequests}`);
  }

  const readerFacing = await aiJsonWithMeta<{ route: string }>("system", "reader-facing final content");
  if (readerFacing.value.route !== "primary" || readerFacing.meta.route !== "primary") {
    throw new Error(`reader-facing call leaked onto economy route: ${JSON.stringify(readerFacing)}`);
  }
  if (economyRequests !== 1 || primaryRequests !== 1 || fallbackRequests !== 0) {
    throw new Error("reader-facing call should use primary/fallback path only");
  }

  economyMode = "retryable";
  const recoveredRetryable = await aiJson<{ route: string }>("system", "economy 503 recovery");
  if (recoveredRetryable.route !== "primary") throw new Error("economy retryable failure did not recover once through normal route");
  if (economyRequests !== 2 || primaryRequests !== 2 || fallbackRequests !== 0) {
    throw new Error("economy retryable recovery exceeded or skipped bounded routing");
  }

  economyMode = "fatal";
  const recoveredFatal = await aiJson<{ route: string }>("system", "economy configuration failure recovery");
  if (recoveredFatal.route !== "primary") throw new Error("economy fatal failure did not recover through normal route");
  if (economyRequests !== 3 || primaryRequests !== 3 || fallbackRequests !== 0) {
    throw new Error("economy fatal recovery exceeded or skipped bounded routing");
  }

  economyMode = "malformed";
  let malformedRejected = false;
  const primaryBeforeMalformed = primaryRequests;
  try {
    await aiJson("system", "malformed economy output");
  } catch (error) {
    malformedRejected = String(error).includes("AI returned invalid JSON");
  }
  if (!malformedRejected) throw new Error("malformed economy model output was accepted");
  if (primaryRequests !== primaryBeforeMalformed) throw new Error("malformed economy output was silently regenerated on primary");
  if (economyRequests !== 4) throw new Error("malformed economy test did not make exactly one economy call");

  const routing = aiRoutingStatus();
  if (routing.internalPolicy !== "economy" || !routing.economyConfigured) throw new Error(`economy policy not visible in routing status: ${JSON.stringify(routing)}`);
  if (routing.economyAttempts24h !== 4 || routing.economySuccesses24h !== 2 || routing.economyFailures24h !== 2) {
    throw new Error(`economy statistics are incorrect: ${JSON.stringify(routing)}`);
  }
  if (routing.fallbackAttempts24h !== 0 || routing.fallbackSuccesses24h !== 0 || routing.fallbackFailures24h !== 0) {
    throw new Error(`economy attempts contaminated fallback health statistics: ${JSON.stringify(routing)}`);
  }
  if (routing.primaryAttempts24h !== 3) throw new Error(`unexpected primary attempt count: ${routing.primaryAttempts24h}`);
  if (aiBudgetStatus().calls !== 7) throw new Error(`economy + recovery calls did not share daily budget: ${aiBudgetStatus().calls}`);

  // F-033: three consecutive economy transport/config failures should open a
  // warning incident even though primary recovery keeps the garden working.
  const created = new Date(Date.now() - 86400000).toISOString();
  {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO blogs
      (id,name,niche,platform,site_url,keywords_json,feeds_json,credentials_cipher,publish_mode,cadence_hours,daily_limit,language,timezone,active,last_run_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "ci-economy-blog", "CI Economy Blog", "test", "wordpress", "https://example.invalid", "[]", "[]", "unused", "auto", 24, 1, "ja", "Asia/Tokyo", 1, null, created,
      );
    db.close();
  }

  economyMode = "retryable";
  for (let index = 0; index < 3; index += 1) {
    const recovered = await aiJson<{ route: string }>("system", `persistent economy failure ${index}`);
    if (recovered.route !== "primary") throw new Error("persistent economy failure did not recover through primary");
  }
  if (economyRequests !== 7 || primaryRequests !== 6 || fallbackRequests !== 0) {
    throw new Error(`persistent economy recovery counts are wrong: economy=${economyRequests} primary=${primaryRequests} fallback=${fallbackRequests}`);
  }

  await reconcileAiRoutingIncidents();
  let incidentDb = new Database(dbPath, { readonly: true });
  let incident = incidentDb.prepare("SELECT status,severity,resolved_at FROM operational_incidents WHERE code='ai-economy-degraded' AND scope='system'").get() as
    | { status: string; severity: string; resolved_at: string | null }
    | undefined;
  const duplicateCount = Number((incidentDb.prepare("SELECT COUNT(*) n FROM operational_incidents WHERE code='ai-economy-degraded' AND scope='system'").get() as { n: number }).n);
  incidentDb.close();
  if (!incident || incident.status !== "open" || incident.severity !== "warning" || duplicateCount !== 1) {
    throw new Error(`economy degradation incident was not opened once as warning: ${JSON.stringify({ incident, duplicateCount })}`);
  }

  // Reconciliation while the condition remains true must update the same row,
  // not create a new incident.
  await reconcileAiRoutingIncidents();
  incidentDb = new Database(dbPath, { readonly: true });
  const stillOne = Number((incidentDb.prepare("SELECT COUNT(*) n FROM operational_incidents WHERE code='ai-economy-degraded' AND scope='system'").get() as { n: number }).n);
  incidentDb.close();
  if (stillOne !== 1) throw new Error("economy degradation incident duplicated while still active");

  economyMode = "healthy";
  const economyRecovered = await aiJson<{ route: string }>("system", "economy recovered");
  if (economyRecovered.route !== "economy") throw new Error("economy did not return to its configured route after recovery");
  await reconcileAiRoutingIncidents();
  incidentDb = new Database(dbPath, { readonly: true });
  incident = incidentDb.prepare("SELECT status,severity,resolved_at FROM operational_incidents WHERE code='ai-economy-degraded' AND scope='system'").get() as
    | { status: string; severity: string; resolved_at: string | null }
    | undefined;
  incidentDb.close();
  if (!incident || incident.status !== "closed" || !incident.resolved_at) {
    throw new Error(`economy recovery did not close incident: ${JSON.stringify(incident)}`);
  }

  const safeBase = process.env.AI_ECONOMY_BASE_URL;
  const safeModel = process.env.AI_ECONOMY_MODEL;
  const safePolicy = process.env.AI_INTERNAL_ROUTE_POLICY;

  process.env.AI_ECONOMY_BASE_URL = `http://127.0.0.2:${port}/economy`;
  delete process.env.AI_ECONOMY_API_KEY;
  let crossHostRejected = false;
  try {
    resolveEconomyRoute();
  } catch (error) {
    crossHostRejected = String(error).includes("AI_ECONOMY_API_KEY is required");
  }
  if (!crossHostRejected) throw new Error("cross-host economy route reused primary credential");

  process.env.AI_ECONOMY_API_KEY = process.env.AI_API_KEY;
  let sameCredentialRejected = false;
  try {
    resolveEconomyRoute();
  } catch (error) {
    sameCredentialRejected = String(error).includes("credential different from AI_API_KEY");
  }
  if (!sameCredentialRejected) throw new Error("cross-host economy route accepted primary credential value");

  process.env.AI_ECONOMY_API_KEY = "ci-dedicated-economy-key";
  if (!resolveEconomyRoute()) throw new Error("dedicated cross-host economy credential was not accepted");

  delete process.env.AI_ECONOMY_API_KEY;
  process.env.AI_ECONOMY_BASE_URL = safeBase;
  delete process.env.AI_ECONOMY_MODEL;
  let missingModelRejected = false;
  try {
    resolveEconomyRoute();
  } catch (error) {
    missingModelRejected = String(error).includes("AI_ECONOMY_MODEL is required");
  }
  if (!missingModelRejected) throw new Error("economy policy without model was silently accepted");

  process.env.AI_ECONOMY_MODEL = safeModel;
  process.env.AI_INTERNAL_ROUTE_POLICY = "invalid-policy";
  let invalidPolicyRejected = false;
  try {
    resolveEconomyRoute();
  } catch (error) {
    invalidPolicyRejected = String(error).includes("AI_INTERNAL_ROUTE_POLICY");
  }
  if (!invalidPolicyRejected) throw new Error("invalid internal route policy was silently accepted");

  process.env.AI_INTERNAL_ROUTE_POLICY = safePolicy;
  console.log(JSON.stringify({
    ok: true,
    primaryRequests,
    fallbackRequests,
    economyRequests,
    calls: aiBudgetStatus().calls,
    routing: aiRoutingStatus(),
  }));
} finally {
  server.close();
}
