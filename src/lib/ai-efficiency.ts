import { aiCostEstimate, type AiScopeCostSummary } from "./ai-cost";
import type { DashboardBlog } from "./types";

export interface BlogAiEfficiencyObservation {
  blogId: string;
  blogName: string;
  aiCalls7d: number;
  aiEstimatedCost7d: number | null;
  aiPriceCoveragePercent: number | null;
  aiUsageComplete: boolean;
  publications7d: number;
  views7d: number;
  sessions7d: number;
  engagementRate: number | null;
  nativeComments: number;
  searchWindowStart: string | null;
  searchWindowEnd: string | null;
  searchClicks: number;
  searchImpressions: number;
  searchCtrPercent: number | null;
  searchPosition: number | null;
}

export interface AiEfficiencyPanel {
  currency: string;
  priceConfigured: boolean;
  priceError: string | null;
  attributionCallCoveragePercent: number | null;
  attributionTokenCoveragePercent: number | null;
  observations: BlogAiEfficiencyObservation[];
}

function scopeForBlog(scopes: AiScopeCostSummary[], blogId: string): AiScopeCostSummary | undefined {
  return scopes.find((scope) => scope.scopeKey === `blog:${blogId}`);
}

function windowStart(end: string | null): string | null {
  if (!end) return null;
  const parsed = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Date(parsed.getTime() - 6 * 86400000).toISOString().slice(0, 10);
}

function safeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function aiEfficiencyPanel(blogs: DashboardBlog[]): AiEfficiencyPanel {
  let currency = (process.env.AI_PRICE_CURRENCY?.trim() || "USD").toUpperCase();
  let priceConfigured = false;
  let priceError: string | null = null;
  let scopes: AiScopeCostSummary[] = [];
  let attributionCallCoveragePercent: number | null = null;
  let attributionTokenCoveragePercent: number | null = null;

  try {
    const estimate = aiCostEstimate();
    currency = estimate.currency;
    priceConfigured = estimate.configured;
    scopes = estimate.scopes;
    attributionCallCoveragePercent = estimate.attributionCallCoveragePercent;
    attributionTokenCoveragePercent = estimate.attributionTokenCoveragePercent;
  } catch (error) {
    priceError = safeError(error);
  }

  const observations = blogs.map((blog): BlogAiEfficiencyObservation => {
    const scope = scopeForBlog(scopes, blog.id);
    return {
      blogId: blog.id,
      blogName: blog.name,
      aiCalls7d: scope?.calls ?? 0,
      aiEstimatedCost7d: priceConfigured ? scope?.last7dEstimatedCost ?? 0 : null,
      aiPriceCoveragePercent: scope?.coveragePercent ?? null,
      aiUsageComplete: Boolean(scope?.complete),
      publications7d: blog.publications7d,
      views7d: blog.views7d,
      sessions7d: blog.sessions7d,
      engagementRate: blog.engagementRate,
      nativeComments: blog.nativeComments,
      searchWindowStart: windowStart(blog.searchWindowEnd),
      searchWindowEnd: blog.searchWindowEnd,
      searchClicks: blog.searchClicks,
      searchImpressions: blog.searchImpressions,
      searchCtrPercent: blog.searchCtrPercent,
      searchPosition: blog.searchPosition,
    };
  });

  return {
    currency,
    priceConfigured,
    priceError,
    attributionCallCoveragePercent,
    attributionTokenCoveragePercent,
    observations,
  };
}
