import { aiCostEstimate, type AiScopeCostSummary } from "./ai-cost";
import type { DashboardBlog } from "./types";

export type AiObservationFlagCode =
  | "cost-coverage-gap"
  | "calls-without-publication"
  | "high-call-density"
  | "outcome-data-sparse"
  | "recent-run-errors";

export interface AiObservationFlag {
  code: AiObservationFlagCode;
  tone: "info" | "warn";
  title: string;
  detail: string;
}

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
  failedRuns7d: number;
  flags: AiObservationFlag[];
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

function observationFlags(input: {
  aiCalls7d: number;
  aiUsageComplete: boolean;
  publications7d: number;
  views7d: number;
  sessions7d: number;
  nativeComments: number;
  searchWindowEnd: string | null;
  failedRuns7d: number;
  priceConfigured: boolean;
  priceError: string | null;
}): AiObservationFlag[] {
  const flags: AiObservationFlag[] = [];

  // These are deliberately operational observations, not performance grades.
  // None of them changes routing, publish mode, budgets, or blog active state.
  if (input.aiCalls7d > 0 && input.priceConfigured && !input.priceError && !input.aiUsageComplete) {
    flags.push({
      code: "cost-coverage-gap",
      tone: "info",
      title: "費用coverageを確認",
      detail: "AI callはありますが、このブログのtoken usageまたはmodel単価が一部不足しています。表示額を完全な費用とは扱いません。",
    });
  }

  if (input.aiCalls7d >= 4 && input.publications7d === 0) {
    flags.push({
      code: "calls-without-publication",
      tone: "warn",
      title: "AI callあり・新規記事0",
      detail: "直近7日でAI callを4回以上使っていますが新規publicationはありません。refresh・draft・失敗・手動処理など正当な理由もあるため、run logの内訳を確認してください。",
    });
  }

  // Normal new-article flow usually needs planning + reader-facing generation.
  // Requiring >=12 calls AND >=6 calls per recent publication keeps this signal
  // conservative enough that ordinary 2-call article creation is never flagged.
  if (input.publications7d > 0 && input.aiCalls7d >= 12 && input.aiCalls7d >= input.publications7d * 6) {
    flags.push({
      code: "high-call-density",
      tone: "info",
      title: "AI call密度を確認",
      detail: "新規publication数に対してAI callが多めです。fallback救済・refresh・再試行などの運用理由を確認するための参考フラグで、効率低下やROI悪化を意味しません。",
    });
  }

  const noOutcomeData = input.views7d === 0
    && input.sessions7d === 0
    && input.nativeComments === 0
    && !input.searchWindowEnd;
  if (input.aiCalls7d >= 3 && noOutcomeData) {
    flags.push({
      code: "outcome-data-sparse",
      tone: "info",
      title: "成果データがまだ薄い",
      detail: "AI運用は始まっていますが、GA4・native comments・確定Search Consoleの観測値がまだありません。新規ブログや連携直後では正常なので、低評価には使いません。",
    });
  }

  if (input.failedRuns7d >= 2) {
    flags.push({
      code: "recent-run-errors",
      tone: "warn",
      title: "最近の実行エラーを確認",
      detail: `直近7日のrun logに${input.failedRuns7d}件のerrorがあります。費用や成果との因果は推測せず、まず失敗種別を確認してください。`,
    });
  }

  return flags;
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
    const aiCalls7d = scope?.calls ?? 0;
    const aiUsageComplete = Boolean(scope?.complete);
    const flags = observationFlags({
      aiCalls7d,
      aiUsageComplete,
      publications7d: blog.publications7d,
      views7d: blog.views7d,
      sessions7d: blog.sessions7d,
      nativeComments: blog.nativeComments,
      searchWindowEnd: blog.searchWindowEnd,
      failedRuns7d: blog.failedRuns,
      priceConfigured,
      priceError,
    });
    return {
      blogId: blog.id,
      blogName: blog.name,
      aiCalls7d,
      aiEstimatedCost7d: priceConfigured ? scope?.last7dEstimatedCost ?? 0 : null,
      aiPriceCoveragePercent: scope?.coveragePercent ?? null,
      aiUsageComplete,
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
      failedRuns7d: blog.failedRuns,
      flags,
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
