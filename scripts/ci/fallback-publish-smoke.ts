import { rmSync } from "node:fs";

const dbPath = ".ci/fallback-publish.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
process.env.DATABASE_PATH = dbPath;
process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
process.env.NODE_ENV = "development";

const { encryptJson } = await import("../../src/lib/crypto");
const { createBlog, recordPublication, recordRun } = await import("../../src/lib/db");
const {
  fallbackApprovedPublishQueue,
  fallbackPublishEligibility,
  recordFallbackReviewOutcome,
} = await import("../../src/lib/fallback-review");
const { acquireBlogLease, releaseBlogLease } = await import("../../src/lib/leases");
const {
  FallbackDraftPublishError,
  publishApprovedFallbackDraft,
} = await import("../../src/lib/fallback-publish");
const { getPublicationById } = await import("../../src/lib/publication-store");

const blog = createBlog({
  name: "Fallback Publish Blog",
  niche: "testing",
  platform: "wordpress",
  siteUrl: "https://example.test",
  keywords: ["test"],
  feeds: [],
  credentialsCipher: encryptJson({ marker: "decrypted-credentials" }),
  publishMode: "auto",
  cadenceHours: 24,
  dailyLimit: 1,
  language: "ja",
  timezone: "Asia/Tokyo",
  ga4PropertyId: null,
  searchConsoleSiteUrl: null,
  active: true,
});

function makeFallbackDraft(platformPostId: string, title: string) {
  const publication = recordPublication({
    blogId: blog.id,
    platformPostId,
    title,
    url: `https://example.test/${platformPostId}`,
    status: "draft",
    sourceUrls: ["https://source.test/item"],
    publishedAt: null,
  });
  const started = new Date().toISOString();
  recordRun(blog.id, "editorial", "ok", "forced fallback review", {
    result: { platformPostId, status: "draft" },
    aiRoute: { route: "fallback", label: "backup-provider", model: "backup-model", bypassedPrimary: true },
    fallbackContentPolicy: "review",
    fallbackForcedReview: true,
  }, started);
  return publication;
}

const approved = makeFallbackDraft("approved-draft", "Approved fallback draft");
let eligibility = fallbackPublishEligibility(approved.id);
if (eligibility.reason !== "not-reviewed") throw new Error(`unreviewed draft unexpectedly eligible: ${JSON.stringify(eligibility)}`);

recordFallbackReviewOutcome(approved.id, "needs-improvement");
eligibility = fallbackPublishEligibility(approved.id);
if (eligibility.reason !== "not-quality-ok") throw new Error(`needs-improvement draft unexpectedly eligible: ${JSON.stringify(eligibility)}`);
if (fallbackApprovedPublishQueue().length !== 0) throw new Error("needs-improvement draft entered approved publish queue");

recordFallbackReviewOutcome(approved.id, "quality-ok");
eligibility = fallbackPublishEligibility(approved.id);
if (!eligibility.eligible) throw new Error(`quality-ok fallback draft was not eligible: ${JSON.stringify(eligibility)}`);
let ready = fallbackApprovedPublishQueue();
if (ready.length !== 1 || ready[0].publicationId !== approved.id) throw new Error(`approved queue mismatch: ${JSON.stringify(ready)}`);
if (ready[0].providerLabel !== "backup-provider" || ready[0].model !== "backup-model" || !ready[0].bypassedPrimary) {
  throw new Error(`approved queue lost AI provenance: ${JSON.stringify(ready[0])}`);
}

let publishCalls = 0;
const mockAdapter = {
  validate: async () => ({ label: "ok" }),
  publish: async () => { throw new Error("not used"); },
  publishDraft: async (_blog: any, credentials: any, publication: any) => {
    publishCalls += 1;
    if (credentials.marker !== "decrypted-credentials") throw new Error("credentials were not decrypted for explicit publish");
    if (publication.id !== approved.id || publication.status !== "draft") throw new Error("wrong draft passed to adapter");
    return {
      platformPostId: publication.platformPostId,
      url: "https://example.test/published-approved-draft",
      status: "published" as const,
      publishedAt: "2026-08-26T06:00:00.000Z",
    };
  },
  readPost: async () => ({ title: "", html: "", excerpt: "", updatedAt: null }),
  updatePost: async () => ({ url: "", updatedAt: null }),
};

const published = await publishApprovedFallbackDraft(approved.id, () => mockAdapter);
if (published.status !== "published" || publishCalls !== 1) throw new Error("approved fallback draft did not publish exactly once");
const local = getPublicationById(approved.id);
if (!local || local.status !== "published" || local.url !== "https://example.test/published-approved-draft") {
  throw new Error(`local publication did not reconcile: ${JSON.stringify(local)}`);
}
if (fallbackApprovedPublishQueue().length !== 0) throw new Error("published fallback draft remained in ready queue");
if (fallbackPublishEligibility(approved.id).reason !== "not-draft") throw new Error("published fallback draft remained eligible");

let repeatedRejected = false;
try {
  await publishApprovedFallbackDraft(approved.id, () => mockAdapter);
} catch (error) {
  repeatedRejected = error instanceof FallbackDraftPublishError && error.code === "not-eligible";
}
if (!repeatedRejected || publishCalls !== 1) throw new Error("repeat publish was not rejected before adapter mutation");

const ordinary = recordPublication({
  blogId: blog.id,
  platformPostId: "ordinary-draft",
  title: "Ordinary draft",
  url: "https://example.test/ordinary-draft",
  status: "draft",
  sourceUrls: [],
  publishedAt: null,
});
recordFallbackReviewOutcome(ordinary.id, "quality-ok");
if (fallbackPublishEligibility(ordinary.id).reason !== "not-forced-fallback") throw new Error("ordinary draft bypassed fallback provenance gate");

const busyDraft = makeFallbackDraft("busy-draft", "Busy fallback draft");
recordFallbackReviewOutcome(busyDraft.id, "quality-ok");
const heldLease = acquireBlogLease(blog.id, 15);
if (!heldLease) throw new Error("failed to acquire test lease");
let busyRejected = false;
try {
  await publishApprovedFallbackDraft(busyDraft.id, () => mockAdapter);
} catch (error) {
  busyRejected = error instanceof FallbackDraftPublishError && error.code === "busy";
} finally {
  releaseBlogLease(heldLease);
}
if (!busyRejected) throw new Error("concurrent blog lease did not block explicit publish");

console.log(JSON.stringify({ ok: true, approvedPublicationId: approved.id, publishCalls }));
