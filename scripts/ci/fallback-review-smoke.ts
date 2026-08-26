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
const fallbackPublication = Number(db.prepare(`INSERT INTO publications
  (blog_id,platform_post_id,title,url,status,created_at) VALUES (?,?,?,?,?,?)`)
  .run("b1", "post-fallback", "Fallback Draft", "https://example.test/draft", "draft", now).lastInsertRowid);
const primaryPublication = Number(db.prepare(`INSERT INTO publications
  (blog_id,platform_post_id,title,url,status,created_at) VALUES (?,?,?,?,?,?)`)
  .run("b1", "post-primary", "Primary Post", "https://example.test/primary", "published", now).lastInsertRowid);

db.prepare(`INSERT INTO run_logs
  (blog_id,kind,status,message,meta_json,started_at,finished_at) VALUES (?,?,?,?,?,?,?)`).run(
  "b1",
  "editorial",
  "ok",
  "Fallback-generated article was forced to review draft",
  JSON.stringify({
    result: { platformPostId: "post-fallback", status: "draft" },
    aiRoute: { route: "fallback", label: "backup-provider", model: "backup-model", bypassedPrimary: true },
    fallbackContentPolicy: "review",
    fallbackForcedReview: true,
  }),
  now,
  now,
);
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

const { fallbackReviewQueue, markFallbackReviewReviewed } = await import("../../src/lib/fallback-review");
let queue = fallbackReviewQueue();
if (queue.length !== 1) throw new Error(`expected exactly one fallback review item, got ${queue.length}`);
if (queue[0].publicationId !== fallbackPublication) throw new Error("wrong publication entered fallback review queue");
if (queue[0].providerLabel !== "backup-provider" || queue[0].model !== "backup-model") {
  throw new Error(`AI provenance missing from review queue: ${JSON.stringify(queue[0])}`);
}
if (!queue[0].bypassedPrimary) throw new Error("circuit bypass provenance was not preserved");
if (queue.some((item) => item.publicationId === primaryPublication)) throw new Error("primary publication leaked into fallback review queue");

markFallbackReviewReviewed(fallbackPublication);
queue = fallbackReviewQueue();
if (queue.length !== 0) throw new Error("reviewed fallback draft remained in pending queue");

console.log(JSON.stringify({ ok: true, reviewedPublicationId: fallbackPublication }));
