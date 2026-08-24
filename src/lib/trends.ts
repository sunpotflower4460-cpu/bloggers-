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

async function parseFeed(url: string, source: string): Promise<SourceCandidate[]> {
  try {
    const feed = await parser.parseURL(url);
    return feed.items.map((item) => toCandidate(item, source)).filter(Boolean) as SourceCandidate[];
  } catch (error) {
    console.warn(`[feed] ${source} failed`, error);
    return [];
  }
}

export async function collectTrends(blog: Blog): Promise<SourceCandidate[]> {
  const query = blog.keywords.length ? blog.keywords.join(" OR ") : blog.niche;
  const googleNews = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
  const groups = await Promise.all([
    parseFeed(googleNews, "Google News"),
    ...blog.feeds.map((url) => parseFeed(url, new URL(url).hostname)),
  ]);
  const map = new Map<string, SourceCandidate>();
  for (const item of groups.flat()) if (!map.has(item.url)) map.set(item.url, item);
  return [...map.values()].slice(0, 60);
}
