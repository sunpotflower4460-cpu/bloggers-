import type { Blog } from "../types";
import { recentPublications, upsertSearchSnapshot } from "../db";
import { googleServiceToken } from "../google-auth";

interface SearchRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

function day(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

function canonical(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.origin}${url.pathname.replace(/\/$/, "")}${url.search}`;
  } catch {
    return value.replace(/\/$/, "");
  }
}

export async function collectSearchConsole(blog: Blog): Promise<number> {
  if (!blog.searchConsoleSiteUrl) return 0;
  const token = await googleServiceToken(["https://www.googleapis.com/auth/webmasters.readonly"]);
  if (!token) return 0;

  // Search Console final data can lag. Use a finalized seven-day window ending three days ago.
  const endDate = day(3);
  const startDate = day(9);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(blog.searchConsoleSiteUrl)}/searchAnalytics/query`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      startDate,
      endDate,
      dimensions: ["page", "query"],
      type: "web",
      aggregationType: "auto",
      rowLimit: 5000,
      dataState: "final",
    }),
  });
  if (!response.ok) throw new Error(`Search Console query failed ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { rows?: SearchRow[] };

  const byPage = new Map<string, Array<{ query: string; clicks: number; impressions: number; position: number }>>();
  for (const row of payload.rows ?? []) {
    const page = row.keys?.[0];
    const query = row.keys?.[1];
    if (!page || !query) continue;
    const list = byPage.get(canonical(page)) ?? [];
    list.push({
      query,
      clicks: Number(row.clicks || 0),
      impressions: Number(row.impressions || 0),
      position: Number(row.position || 0),
    });
    byPage.set(canonical(page), list);
  }

  let matched = 0;
  for (const publication of recentPublications(blog.id, 150)) {
    const rows = byPage.get(canonical(publication.url));
    if (!rows?.length) continue;
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    const weightedPosition = impressions > 0
      ? rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions
      : 0;
    const topQueries = [...rows]
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, 8)
      .map((row) => row.query);
    upsertSearchSnapshot(
      publication.id,
      endDate,
      clicks,
      impressions,
      impressions > 0 ? clicks / impressions : 0,
      weightedPosition,
      topQueries,
    );
    matched += 1;
  }
  return matched;
}
