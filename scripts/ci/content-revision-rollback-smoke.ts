import Database from "better-sqlite3";
import http from "node:http";
import { readFileSync, rmSync } from "node:fs";

const dbPath = ".ci/content-revision-rollback.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
process.env.DATABASE_PATH = dbPath;
process.env.APP_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000000";
process.env.ALERT_WEBHOOK_KIND = "generic";

let modifiedCounter = 0;
const post = {
  title: "Original headline",
  content: "<p>Original body</p>",
  excerpt: "Original excerpt",
};
const updateBodies: Array<Record<string, unknown>> = [];
const notifications: Array<Record<string, unknown>> = [];

const server = http.createServer((request, response) => {
  if (request.url === "/webhook" && request.method === "POST") {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      notifications.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    return;
  }
  if (!request.url?.startsWith("/wp-json/wp/v2/posts/post-1")) {
    response.writeHead(404); response.end("not found"); return;
  }
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "post-1",
      status: "publish",
      link: "https://example.test/post-1",
      title: { raw: post.title },
      content: { raw: post.content },
      excerpt: { raw: post.excerpt },
      modified_gmt: `2026-08-26T12:00:${String(modifiedCounter).padStart(2, "0")}`,
    }));
    return;
  }
  if (request.method === "POST") {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      updateBodies.push(body);
      if (typeof body.title === "string") post.title = body.title;
      if (typeof body.content === "string") post.content = body.content;
      if (typeof body.excerpt === "string") post.excerpt = body.excerpt;
      modifiedCounter += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "post-1",
        link: "https://example.test/post-1",
        modified_gmt: `2026-08-26T12:00:${String(modifiedCounter).padStart(2, "0")}`,
      }));
    });
    return;
  }
  response.writeHead(405); response.end("method not allowed");
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock WordPress did not bind a port");
const siteUrl = `http://127.0.0.1:${address.port}`;
process.env.ALERT_WEBHOOK_URL = `${siteUrl}/webhook`;

try {
  const { encryptJson } = await import("../../src/lib/crypto");
  const { createBlog, recordPublication, setBlogActive } = await import("../../src/lib/db");
  const { platformAdapter } = await import("../../src/lib/platforms");
  const { getPublicationById } = await import("../../src/lib/publication-store");
  const {
    getContentRevision,
    markContentRevisionApplied,
    prepareContentRevision,
    revisionAttentionQueue,
    rollbackRevisionQueue,
  } = await import("../../src/lib/content-revisions");
  const { recordContentRefresh, latestContentRefresh } = await import("../../src/lib/refresh-store");
  const { ContentRollbackError, rollbackContentRevision } = await import("../../src/lib/content-rollback");
  const { runOperationalMonitor } = await import("../../src/lib/ops-monitor");

  const blog = createBlog({
    name: "Revision Garden",
    niche: "test",
    platform: "wordpress",
    siteUrl,
    keywords: ["test"],
    feeds: [],
    credentialsCipher: encryptJson({ username: "ci", applicationPassword: "ci-password" }),
    publishMode: "auto",
    cadenceHours: 24,
    dailyLimit: 1,
    language: "ja",
    timezone: "UTC",
    ga4PropertyId: null,
    searchConsoleSiteUrl: null,
    active: true,
  });
  const publication = recordPublication({
    blogId: blog.id,
    platformPostId: "post-1",
    title: post.title,
    url: "https://example.test/post-1",
    status: "published",
    sourceUrls: [],
    publishedAt: new Date().toISOString(),
  });
  const adapter = platformAdapter("wordpress");
  const credentials = { username: "ci", applicationPassword: "ci-password" };

  // Simulate the F-051 engine sequence: prepare snapshot before remote mutation,
  // apply title-only change, then finalize the revision and refresh record.
  const before = await adapter.readPost(blog, credentials, publication);
  const revision = prepareContentRevision({
    publicationId: publication.id,
    mutationKind: "headline-refresh",
    axes: ["headline"],
    before,
    update: { title: "Autonomous headline" },
  });
  if (revision.status !== "prepared" || rollbackRevisionQueue().length !== 0) {
    throw new Error("prepared revision must exist before remote mutation but not be rollback-ready yet");
  }
  const appliedResult = await adapter.updatePost(blog, credentials, publication, { title: "Autonomous headline" }, before);
  markContentRevisionApplied(revision.id, { updatedAt: appliedResult.updatedAt });
  recordContentRefresh({
    publicationId: publication.id,
    revisionId: revision.id,
    beforeTitle: "Original headline",
    afterTitle: "Autonomous headline",
    hypothesis: "test",
    reason: "test",
    trigger: {},
    url: appliedResult.url,
  });
  if (post.title !== "Autonomous headline" || rollbackRevisionQueue()[0]?.id !== revision.id) {
    throw new Error("applied revision was not exposed as rollback-ready");
  }

  const rolledBack = await rollbackContentRevision(revision.id);
  if (post.title !== "Original headline") throw new Error(`rollback did not restore the title: ${post.title}`);
  if (post.content !== "<p>Original body</p>" || post.excerpt !== "Original excerpt") {
    throw new Error("headline rollback overwrote fields outside the recorded axis");
  }
  const rollbackBody = updateBodies.at(-1) || {};
  if (JSON.stringify(Object.keys(rollbackBody).sort()) !== JSON.stringify(["title"])) {
    throw new Error(`rollback mutation was not title-only: ${JSON.stringify(rollbackBody)}`);
  }
  if (rolledBack.title !== "Original headline" || rollbackRevisionQueue().some((item) => item.id === revision.id)) {
    throw new Error("rolled-back revision remained in the rollback queue");
  }
  const refresh = latestContentRefresh(blog.id);
  if (!refresh?.rolledBackAt || refresh.revisionId !== revision.id) {
    throw new Error(`refresh learning state did not record rollback: ${JSON.stringify(refresh)}`);
  }

  // Create a second autonomous title mutation, then imitate a human changing the
  // headline directly in WordPress. Rollback must refuse rather than overwrite it.
  const secondBefore = await adapter.readPost(blog, credentials, publication);
  const second = prepareContentRevision({
    publicationId: publication.id,
    mutationKind: "headline-refresh",
    axes: ["headline"],
    before: secondBefore,
    update: { title: "Second autonomous headline" },
  });
  const secondResult = await adapter.updatePost(blog, credentials, publication, { title: "Second autonomous headline" }, secondBefore);
  markContentRevisionApplied(second.id, { updatedAt: secondResult.updatedAt });
  post.title = "Human-edited headline";
  modifiedCounter += 1;

  let conflict = false;
  try {
    await rollbackContentRevision(second.id);
  } catch (error) {
    conflict = error instanceof ContentRollbackError && error.code === "conflict";
  }
  if (!conflict) throw new Error("human headline edit did not block rollback");
  if (post.title !== "Human-edited headline") throw new Error("collision-safe rollback overwrote the human headline");
  if (getContentRevision(second.id)?.status !== "applied" || !rollbackRevisionQueue().some((item) => item.id === second.id)) {
    throw new Error("conflicted revision must remain applied and reviewable");
  }

  // F-052 runs even for an inactive blog, but disabling the garden prevents the
  // general monitor from adding unrelated platform-auth/worker signals in this smoke.
  setBlogActive(blog.id, false);
  const auditDb = new Database(dbPath);
  const makeStale = (revisionId: number) => auditDb.prepare("UPDATE content_revisions SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 30 * 60000).toISOString(), revisionId);
  const monitorMutationBaseline = updateBodies.length;

  // Crash before the CMS mutation: live content still equals BEFORE. The monitor
  // can prove no external mutation happened and safely finalize the row as failed.
  const noMutationBefore = await adapter.readPost(blog, credentials, publication);
  const noMutation = prepareContentRevision({
    publicationId: publication.id,
    mutationKind: "headline-refresh",
    axes: ["headline"],
    before: noMutationBefore,
    update: { title: "Crash no-mutation target" },
  });
  makeStale(noMutation.id);
  await runOperationalMonitor();
  if (getContentRevision(noMutation.id)?.status !== "failed") {
    throw new Error("stale prepared revision matching BEFORE was not safely finalized as failed");
  }

  // Crash after the remote CMS succeeded but before local finalization: live
  // content equals AFTER. The monitor recovers local state without writing remotely.
  const remoteAppliedBefore = await adapter.readPost(blog, credentials, publication);
  const remoteApplied = prepareContentRevision({
    publicationId: publication.id,
    mutationKind: "headline-refresh",
    axes: ["headline"],
    before: remoteAppliedBefore,
    update: { title: "Crash remote-applied target" },
  });
  post.title = "Crash remote-applied target";
  modifiedCounter += 1;
  makeStale(remoteApplied.id);
  await runOperationalMonitor();
  if (getContentRevision(remoteApplied.id)?.status !== "applied") {
    throw new Error("stale prepared revision matching AFTER was not recovered as applied");
  }
  if (getPublicationById(publication.id)?.title !== "Crash remote-applied target") {
    throw new Error("recovered applied revision did not reconcile local publication title");
  }

  // Third state: neither BEFORE nor AFTER. This may be a human edit and must not
  // be guessed. Keep PREPARED, open CRITICAL incident, and send one notification.
  const uncertainBefore = await adapter.readPost(blog, credentials, publication);
  const uncertain = prepareContentRevision({
    publicationId: publication.id,
    mutationKind: "headline-refresh",
    axes: ["headline"],
    before: uncertainBefore,
    update: { title: "Expected after crash" },
  });
  post.title = "Third-party headline";
  modifiedCounter += 1;
  makeStale(uncertain.id);
  const uncertainRun = await runOperationalMonitor();
  const openIncident = auditDb.prepare(`SELECT status,severity FROM operational_incidents
    WHERE code='content-revision-uncertain' AND scope=?`).get(`revision:${uncertain.id}`) as { status: string; severity: string } | undefined;
  if (getContentRevision(uncertain.id)?.status !== "prepared" || !openIncident
    || openIncident.status !== "open" || openIncident.severity !== "critical"
    || uncertainRun.notifications !== 1 || notifications.at(-1)?.code !== "content-revision-uncertain"
    || notifications.at(-1)?.severity !== "critical") {
    throw new Error(`uncertain stale revision did not become a CRITICAL incident: ${JSON.stringify({ openIncident, uncertainRun, notifications })}`);
  }
  if (!revisionAttentionQueue(12, 15).some((item) => item.id === uncertain.id && item.status === "prepared")) {
    throw new Error("uncertain stale revision was not visible in the home attention queue source");
  }

  // Once the remote state is safely identifiable as BEFORE, the next monitor can
  // finalize the row as no-mutation and close the incident with RECOVERY.
  post.title = uncertainBefore.title;
  modifiedCounter += 1;
  const recoveredRun = await runOperationalMonitor();
  const closedIncident = auditDb.prepare(`SELECT status,resolved_at FROM operational_incidents
    WHERE code='content-revision-uncertain' AND scope=?`).get(`revision:${uncertain.id}`) as { status: string; resolved_at: string | null } | undefined;
  if (getContentRevision(uncertain.id)?.status !== "failed" || !closedIncident
    || closedIncident.status !== "closed" || !closedIncident.resolved_at
    || recoveredRun.notifications !== 1 || notifications.at(-1)?.severity !== "recovery") {
    throw new Error(`uncertain revision recovery lifecycle is wrong: ${JSON.stringify({ closedIncident, recoveredRun, notifications })}`);
  }
  if (updateBodies.length !== monitorMutationBaseline) {
    throw new Error("F-052 monitor performed a remote CMS mutation; reconciliation must be read-only");
  }
  auditDb.close();

  // Structural safety regression: the real engine must create the snapshot before
  // calling the CMS, the public route must demand explicit confirmation, and the
  // home must surface rollback/attention queues separately.
  const engineSource = readFileSync("src/lib/engine.ts", "utf8");
  const prepareIndex = engineSource.indexOf("const revision = prepareContentRevision({");
  const remoteMutationIndex = engineSource.indexOf("result = await adapter.updatePost", prepareIndex);
  if (prepareIndex < 0 || remoteMutationIndex < 0 || prepareIndex >= remoteMutationIndex) {
    throw new Error("engine no longer prepares a revision snapshot before the autonomous CMS mutation");
  }
  if (!engineSource.includes("markContentRevisionFailed(revision.id, error)")) {
    throw new Error("engine no longer records failed remote mutations against the prepared revision");
  }
  if (!engineSource.includes("revisionId: revision.id")) {
    throw new Error("headline refresh no longer links its revision id into local history");
  }

  const routeSource = readFileSync("src/app/api/revisions/rollback/route.ts", "utf8");
  if (!routeSource.includes("body.confirmRollback !== true") || !routeSource.includes("confirmRollback=true is required")) {
    throw new Error("rollback API no longer requires explicit external-mutation confirmation");
  }
  const homeSource = readFileSync("src/app/page.tsx", "utf8");
  for (const required of [
    "revisionAttentionQueue(12, 15)",
    "自動改善 · 要確認revision",
    "rollbackRevisionQueue(12)",
    "自動改善 · 戻せる変更",
    "<ContentRollbackButton revisionId={revision.id} />",
  ]) {
    if (!homeSource.includes(required)) throw new Error(`home revision safety wiring missing: ${required}`);
  }
  const monitorSource = readFileSync("src/lib/content-revision-monitor.ts", "utf8");
  if (!monitorSource.includes("await adapter.readPost") || monitorSource.includes("adapter.updatePost")) {
    throw new Error("F-052 stale revision monitor is no longer strictly read-only against the CMS");
  }
  const diagnosticsRoute = readFileSync("src/app/api/diagnostics/route.ts", "utf8");
  if (!diagnosticsRoute.includes("contentRevisionOperationalSummary(15)") || !diagnosticsRoute.includes("既存記事revision整合性")) {
    throw new Error("F-052 diagnostics wiring is missing");
  }

  console.log(JSON.stringify({
    ok: true,
    snapshotPreparedBeforeMutation: true,
    explicitRollbackRestoredOnlyChangedAxis: true,
    localRefreshMarkedRolledBack: true,
    humanEditCollisionBlocked: true,
    conflictedRevisionRemainsReviewable: true,
    staleBeforeRecoveredAsFailed: true,
    staleAfterRecoveredAsApplied: true,
    uncertainThirdStateCritical: true,
    uncertainRecoveryWebhook: true,
    staleReconciliationIsReadOnly: true,
    engineOrderingVerified: true,
    explicitApiConfirmationVerified: true,
    homeRollbackQueueVerified: true,
    homeRevisionAttentionVerified: true,
    diagnosticsRevisionHealthVerified: true,
  }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
