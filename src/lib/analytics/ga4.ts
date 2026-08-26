import type { Blog } from "../types";
import { recentPublications, upsertMetric } from "../db";
import { googleServiceToken } from "../google-auth";

export async function collectGa4(blog: Blog): Promise<number> {
  if (!blog.ga4PropertyId) return 0;
  const token = await googleServiceToken(["https://www.googleapis.com/auth/analytics.readonly"]);
  if (!token) return 0;
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${blog.ga4PropertyId}:runReport`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "sessions" }, { name: "engagedSessions" }],
      limit: 10000,
    }),
  });
  if (!response.ok) throw new Error(`GA4 report failed ${response.status}: ${await response.text()}`);
  const report = await response.json();
  const byPath = new Map<string, {views:number;sessions:number;engaged:number}>();
  for (const row of report.rows ?? []) {
    const path = row.dimensionValues?.[0]?.value;
    if (!path) continue;
    byPath.set(path, {
      views: Number(row.metricValues?.[0]?.value || 0),
      sessions: Number(row.metricValues?.[1]?.value || 0),
      engaged: Number(row.metricValues?.[2]?.value || 0),
    });
  }
  const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let matched = 0;
  for (const publication of recentPublications(blog.id, 100)) {
    try {
      const metrics = byPath.get(new URL(publication.url).pathname);
      if (!metrics) continue;
      upsertMetric(publication.id, date, metrics.views, metrics.sessions, metrics.engaged);
      matched += 1;
    } catch { /* invalid historic URL */ }
  }
  return matched;
}
