import Parser from "rss-parser";
import type { Blog, SourceCandidate } from "./types";

const parser = new Parser({ timeout: 15000 });

function toCandidate(item: any, source: string): SourceCandidate | null {
  const title = String(item.title || "").trim();
  const url = String(item.link || "").trim();
  if (!title || !url) return null;
  return {
    title,
    url,
    summary: String(item.contentSnippet || item.content || item.summary || "").slice(0, 1200),
    publishedAt: item.isoDate || item.pubDate || null,
    source,
  };
}

function sourceName(url: string): string {
  try { return new URL(url).hostname; }
  catch { return "custom RSS"; }
}

async function parseFeed(url: string, source: string): Promise<SourceCandidate[]> {
  try {
    const feed = await parser.parseURL(url);
    return feed.items.map((item) => toCandidate(item, source)).filter(Boolean) as SourceCandidate[];
  } catch (error) {
    console.warn(`[feed] ${source} failed`, error);
    return [];
  }
}

function titleKey(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
}

function score(item: SourceCandidate, blog: Blog): number {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const keywordHits = blog.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
  const published = item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
  const ageHours = published > 0 ? Math.max(0, (Date.now() - published) / 3600000) : 9999;
  const freshness = ageHours <= 24 ? 12 : ageHours <= 72 ? 8 : ageHours <= 168 ? 5 : ageHours <= 720 ? 2 : 0;
  const trustedFeedBonus = item.source === "Google News" ? 0 : 2;
  return keywordHits * 4 + freshness + trustedFeedBonus;
}

function diversify(items: SourceCandidate[], blog: Blog): SourceCandidate[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const deduped = items.filter((item) => {
    const key = titleKey(item.title);
    if (seenUrls.has(item.url) || seenTitles.has(key)) return false;
    seenUrls.add(item.url);
    seenTitles.add(key);
    return true;
  });
  deduped.sort((a, b) => score(b, blog) - score(a, blog));

  const sourceCounts = new Map<string, number>();
  const result: SourceCandidate[] = [];
  for (const item of deduped) {
    const count = sourceCounts.get(item.source) || 0;
    if (count >= 12) continue;
    sourceCounts.set(item.source, count + 1);
    result.push(item);
    if (result.length >= 60) break;
  }
  return result;
}

export async function collectTrends(blog: Blog): Promise<SourceCandidate[]> {
  const queries = (blog.keywords.length ? blog.keywords : [blog.niche]).slice(0, 8);
  const newsFeeds = queries.map((query) =>
    parseFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`, "Google News"),
  );
  const groups = await Promise.all([
    ...newsFeeds,
    ...blog.feeds.map((url) => parseFeed(url, sourceName(url))),
  ]);
  return diversify(groups.flat(), blog);
}
