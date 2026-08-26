import { rmSync } from "node:fs";

const dbPath = ".ci/fallback-review.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
process.env.DATABASE_PATH = dbPath;

const Database = (await import("better-sqlite3")).default;
const db = new Database(dbPath);
db.exec(`
CREATE TABLE blogs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL
);
CREATE TABLE publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL,
  platform_post_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
`);
const now = new Date().toISOString();
db.prepare("INSERT INTO blogs (id,name,platform) VALUES (?,?,?)").run("b1", "Fallback Blog", "wordpress");

const fallbackIds: number[] = [];
for (let i = 0; i < 10; i += 1) {
  const platformPostId = `post-fallback-${i}`;
  const publicationId = Number(db.prepare(`INSERT INTO publications
    (blog_id,platform_post_id,title,url,status,created_at) VALUES (?,?,?,?,?,?)`)
    .run("b1", platformPostId, `Fallback Draft ${i}`, `https://example.test/draft-${i}`, "draft", now).lastInsertRowid);
  fallbackIds.push(publicationId);
  db.prepare(`INSERT INTO run_logs
    (blog_id,kind,status,message,meta_json,started_at,finished_at) VALUES (?,?,?,?,?,?,?)`).run(
    "b1",
    "editorial",
    "ok",
    "Fallback-generated article was forced to review draft",
    JSON.stringify({
      result: { platformPostId, status: "draft" },
      aiRoute: { route: "fallback", label: "backup-provider", model: "backup-model", bypassedPrimary: i === 0 },
      fallbackContentPolicy: "review",
      fallbackForcedReview: true,
    }),
    now,
    now,
  );
}

const primaryPublication = Number(db.prepare(`INSERT INTO publications
  (blog_id,platform_post_id,title,url,status,created_at) VALUES (?,?,?,?,?,?)`)
  .run("b1", "post-primary", "Primary Post", "https://example.test/primary", "published", now).lastInsertRowid);
db.prepare(`INSERT INTO run_logs
  (blog_id,kind,status,message,meta_json,started_at,finished_at) VALUES (?,?,?,?,?,?,?)`).run(
  "b1",
  "editorial",
  "ok",
  "Published primary article",
  JSON.stringify({
    result: { platformPostId: "post-primary", status: "published" },
    aiRoute: { route: "primary", label: "primary", model: "primary-model", bypassedPrimary: false },
    fallbackContentPolicy: "review",
    fallbackForcedReview: false,
  }),
  now,
  now,
);
db.close();

const {
  fallbackQualitySummaries,
  fallbackReviewQueue,
  recordFallbackReviewOutcome,
} = await import("../../src/lib/fallback-review");

let queue = fallbackReviewQueue();
if (queue.length !== 10) throw new Error(`expected 10 fallback review items, got ${queue.length}`);
if (queue.some((item) => item.publicationId === primaryPublication)) throw new Error("primary publication leaked into fallback review queue");
const circuitItem = queue.find((item) => item.publicationId === fallbackIds[0]);
if (!circuitItem || !circuitItem.bypassedPrimary) throw new Error("circuit bypass provenance was not preserved");
if (circuitItem.providerLabel !== "backup-provider" || circuitItem.model !== "backup-model") {
  throw new Error(`AI provenance missing from review queue: ${JSON.stringify(circuitItem)}`);
}

for (let i = 0; i < fallbackIds.length; i += 1) {
  recordFallbackReviewOutcome(fallbackIds[i], i < 9 ? "quality-ok" : "needs-improvement");
}
queue = fallbackReviewQueue();
if (queue.length !== 0) throw new Error("reviewed fallback drafts remained in pending queue");

const summaries = fallbackQualitySummaries();
if (summaries.length !== 1) throw new Error(`expected one provider/model quality summary, got ${summaries.length}`);
const summary = summaries[0];
if (summary.providerLabel !== "backup-provider" || summary.model !== "backup-model") {
  throw new Error(`wrong provider/model quality summary: ${JSON.stringify(summary)}`);
}
if (summary.reviewed !== 10 || summary.qualityOk !== 9 || summary.needsImprovement !== 1) {
  throw new Error(`unexpected quality counts: ${JSON.stringify(summary)}`);
}
if (summary.approvalRate !== 0.9 || summary.signal !== "strong") {
  throw new Error(`90% across 10 reviews must produce strong signal: ${JSON.stringify(summary)}`);
}

let invalidRejected = false;
try {
  recordFallbackReviewOutcome(fallbackIds[0], "invalid" as never);
} catch (error) {
  invalidRejected = String(error).includes("quality-ok or needs-improvement");
}
if (!invalidRejected) throw new Error("invalid fallback review outcome was not rejected");

console.log(JSON.stringify({ ok: true, summary }));
