import { rmSync } from "node:fs";

const dbPath = ".ci/ai-efficiency-observation.sqlite";
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = dbPath;
process.env.AI_BUDGET_TIMEZONE = "UTC";
process.env.AI_DAILY_CALL_LIMIT = "100";
process.env.AI_DAILY_TOKEN_LIMIT = "10000000";
process.env.AI_PRICE_CURRENCY = "USD";
process.env.AI_PRICE_TABLE_JSON = JSON.stringify({
  "primary:model-a": { inputPerMillion: 2, outputPerMillion: 8 },
});

const {
  createBlog,
  dashboard,
  recordPublication,
  recordRun,
  upsertMetric,
  upsertSearchSnapshot,
} = await import("../../src/lib/db");
const { blogAiUsageScope, withAiUsageScope } = await import("../../src/lib/ai-usage-context");
const { recordAiUsage, reserveAiCall } = await import("../../src/lib/ai-budget");
const { aiEfficiencyPanel } = await import("../../src/lib/ai-efficiency");

const blog = createBlog({
  name: "Observation Garden",
  niche: "testing",
  platform: "wordpress",
  siteUrl: "https://example.invalid",
  keywords: ["test"],
  feeds: [],
  credentialsCipher: "ci-placeholder",
  publishMode: "review",
  cadenceHours: 24,
  dailyLimit: 1,
  language: "ja",
  timezone: "UTC",
  ga4PropertyId: "ga4-test",
  searchConsoleSiteUrl: "sc-domain:example.invalid",
  active: true,
});

const publicationA = recordPublication({
  blogId: blog.id,
  platformPostId: "post-a",
  title: "Article A",
  url: "https://example.invalid/a",
  status: "published",
  sourceUrls: [],
  publishedAt: new Date().toISOString(),
});
const publicationB = recordPublication({
  blogId: blog.id,
  platformPostId: "post-b",
  title: "Article B",
  url: "https://example.invalid/b",
  status: "published",
  sourceUrls: [],
  publishedAt: new Date().toISOString(),
});

const today = new Date().toISOString().slice(0, 10);
upsertMetric(publicationA.id, today, 30, 20, 12);
upsertMetric(publicationB.id, today, 10, 8, 4);

// Article B has only an older finalized Search Console window. The dashboard
// must NOT mix it into Article A's newer window.
upsertSearchSnapshot(publicationA.id, "2026-08-20", 100, 1000, 0.1, 4, ["old-a"]);
upsertSearchSnapshot(publicationB.id, "2026-08-20", 50, 500, 0.1, 6, ["old-b"]);
upsertSearchSnapshot(publicationA.id, "2026-08-23", 2, 100, 0.02, 8, ["new-a"]);

await withAiUsageScope(blogAiUsageScope(blog.id, blog.name), async () => {
  reserveAiCall("primary:model-a");
  await Promise.resolve();
  recordAiUsage({ input_tokens: 100_000, output_tokens: 10_000, total_tokens: 110_000 }, "primary:model-a");
});

// F-037: intentionally create an operationally ambiguous garden. It spent
// calls, produced no new publication, has no outcome data, has two run errors,
// and one of four calls lacks provider usage. These are investigation facts,
// not proof that the blog is commercially or editorially underperforming.
const sparseBlog = createBlog({
  name: "Sparse Garden",
  niche: "testing",
  platform: "wordpress",
  siteUrl: "https://sparse.invalid",
  keywords: ["test"],
  feeds: [],
  credentialsCipher: "ci-placeholder",
  publishMode: "review",
  cadenceHours: 24,
  dailyLimit: 1,
  language: "ja",
  timezone: "UTC",
  ga4PropertyId: null,
  searchConsoleSiteUrl: null,
  active: true,
});
await withAiUsageScope(blogAiUsageScope(sparseBlog.id, sparseBlog.name), async () => {
  for (let index = 0; index < 4; index += 1) {
    reserveAiCall("primary:model-a");
    if (index < 3) {
      recordAiUsage({ input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 }, "primary:model-a");
    }
    await Promise.resolve();
  }
});
for (let index = 0; index < 2; index += 1) {
  const started = new Date().toISOString();
  recordRun(sparseBlog.id, "editorial", "error", `synthetic failure ${index}`, {}, started);
}

// A deliberately high call density needs both an absolute floor and a ratio.
// Give it real outcome data so only the density observation is expected.
const denseBlog = createBlog({
  name: "Dense Garden",
  niche: "testing",
  platform: "wordpress",
  siteUrl: "https://dense.invalid",
  keywords: ["test"],
  feeds: [],
  credentialsCipher: "ci-placeholder",
  publishMode: "review",
  cadenceHours: 24,
  dailyLimit: 1,
  language: "ja",
  timezone: "UTC",
  ga4PropertyId: "ga4-dense",
  searchConsoleSiteUrl: null,
  active: true,
});
const densePublicationA = recordPublication({
  blogId: denseBlog.id,
  platformPostId: "dense-a",
  title: "Dense A",
  url: "https://dense.invalid/a",
  status: "published",
  sourceUrls: [],
  publishedAt: new Date().toISOString(),
});
recordPublication({
  blogId: denseBlog.id,
  platformPostId: "dense-b",
  title: "Dense B",
  url: "https://dense.invalid/b",
  status: "published",
  sourceUrls: [],
  publishedAt: new Date().toISOString(),
});
upsertMetric(densePublicationA.id, today, 1, 1, 1);
await withAiUsageScope(blogAiUsageScope(denseBlog.id, denseBlog.name), async () => {
  for (let index = 0; index < 12; index += 1) {
    reserveAiCall("primary:model-a");
    recordAiUsage({ input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 }, "primary:model-a");
    await Promise.resolve();
  }
});

const blogs = dashboard();
const row = blogs.find((item) => item.id === blog.id);
if (!row) throw new Error("dashboard blog missing");
if (row.publications7d !== 2) throw new Error(`expected 2 recent publications, got ${row.publications7d}`);
if (row.views7d !== 40 || row.sessions7d !== 28 || row.engagedSessions7d !== 16) {
  throw new Error(`unexpected GA4 recent observation: ${JSON.stringify(row)}`);
}
if (row.searchWindowEnd !== "2026-08-23") throw new Error(`wrong coherent search window: ${row.searchWindowEnd}`);
if (row.searchClicks !== 2 || row.searchImpressions !== 100 || row.searchCtrPercent !== 2 || row.searchPosition !== 8) {
  throw new Error(`stale Search Console window was mixed into latest window: ${JSON.stringify({
    clicks: row.searchClicks,
    impressions: row.searchImpressions,
    ctr: row.searchCtrPercent,
    position: row.searchPosition,
  })}`);
}
if (row.topSearchQuery !== "new-a") throw new Error(`top query came from wrong search window: ${row.topSearchQuery}`);

const panel = aiEfficiencyPanel(blogs);
const observation = panel.observations.find((item) => item.blogId === blog.id);
if (!observation) throw new Error("AI efficiency observation missing");
if (observation.aiCalls7d !== 1) throw new Error(`wrong blog AI calls: ${observation.aiCalls7d}`);
if (observation.aiEstimatedCost7d === null || Math.abs(observation.aiEstimatedCost7d - 0.28) > 1e-9) {
  throw new Error(`wrong blog AI estimated cost: ${observation.aiEstimatedCost7d}`);
}
if (!observation.aiUsageComplete || observation.aiPriceCoveragePercent !== 100) {
  throw new Error(`complete blog cost observation was marked incomplete: ${JSON.stringify(observation)}`);
}
if (observation.searchWindowStart !== "2026-08-17" || observation.searchWindowEnd !== "2026-08-23") {
  throw new Error(`Search Console seven-day window label is wrong: ${JSON.stringify(observation)}`);
}
if (observation.flags.length !== 0) {
  throw new Error(`healthy ordinary observation was over-flagged: ${JSON.stringify(observation.flags)}`);
}

const sparseObservation = panel.observations.find((item) => item.blogId === sparseBlog.id);
if (!sparseObservation) throw new Error("sparse observation missing");
const sparseFlags = new Set(sparseObservation.flags.map((flag) => flag.code));
for (const expected of ["cost-coverage-gap", "calls-without-publication", "outcome-data-sparse", "recent-run-errors"]) {
  if (!sparseFlags.has(expected as any)) {
    throw new Error(`sparse observation missing ${expected}: ${JSON.stringify(sparseObservation.flags)}`);
  }
}
if (sparseFlags.has("high-call-density")) throw new Error("zero-publication garden must not use per-publication density flag");

const denseObservation = panel.observations.find((item) => item.blogId === denseBlog.id);
if (!denseObservation) throw new Error("dense observation missing");
const denseFlags = new Set(denseObservation.flags.map((flag) => flag.code));
if (!denseFlags.has("high-call-density")) {
  throw new Error(`high call density was not surfaced: ${JSON.stringify(denseObservation.flags)}`);
}
if (denseFlags.has("calls-without-publication") || denseFlags.has("outcome-data-sparse")) {
  throw new Error(`dense observation received contradictory flags: ${JSON.stringify(denseObservation.flags)}`);
}

// F-036/F-037 expose observations and investigation flags side by side; they
// must not manufacture causal ROI / cost-per-click / grade fields.
const unsafeKeys = ["roi", "returnOnInvestment", "costPerClick", "costPerView", "efficiencyScore", "performanceGrade"];
for (const item of panel.observations) {
  for (const key of unsafeKeys) {
    if (key in (item as unknown as Record<string, unknown>)) {
      throw new Error(`non-causal observation unexpectedly exposes ${key}`);
    }
  }
}

// A bad operator price table must not crash the home observation panel. The
// configuration error should be carried as displayable state instead.
process.env.AI_PRICE_TABLE_JSON = "{not-json";
const invalidPricePanel = aiEfficiencyPanel(blogs);
if (!invalidPricePanel.priceError || invalidPricePanel.observations.length !== 3) {
  throw new Error(`price configuration error was not isolated from the panel: ${JSON.stringify(invalidPricePanel)}`);
}
if (invalidPricePanel.observations.some((item) => item.aiEstimatedCost7d !== null)) {
  throw new Error("invalid price configuration produced a misleading cost estimate");
}

console.log(JSON.stringify({
  ok: true,
  searchWindow: [observation.searchWindowStart, observation.searchWindowEnd],
  searchClicks: observation.searchClicks,
  searchImpressions: observation.searchImpressions,
  aiCalls7d: observation.aiCalls7d,
  aiEstimatedCost7d: observation.aiEstimatedCost7d,
  publications7d: observation.publications7d,
  views7d: observation.views7d,
  sparseFlags: [...sparseFlags],
  denseFlags: [...denseFlags],
  priceErrorIsolated: Boolean(invalidPricePanel.priceError),
}));
