export type BlogPlatform = "wordpress" | "ghost" | "blogger";
export type PublishMode = "review" | "auto";

export interface Blog {
  id: string;
  name: string;
  niche: string;
  platform: BlogPlatform;
  siteUrl: string;
  keywords: string[];
  feeds: string[];
  credentialsCipher: string;
  publishMode: PublishMode;
  cadenceHours: number;
  dailyLimit: number;
  language: string;
  timezone: string;
  ga4PropertyId: string | null;
  searchConsoleSiteUrl: string | null;
  active: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface SourceCandidate {
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
  source: string;
}

export interface EditorialExperiment {
  axis: "headline" | "angle" | "structure";
  variant: string;
  hypothesis: string;
}

export interface ArticlePlan {
  sourceUrl: string;
  angle: string;
  audience: string;
  reason: string;
  experiment?: EditorialExperiment;
}

export interface GeneratedArticle {
  title: string;
  excerpt: string;
  html: string;
  tags: string[];
  sourceUrls: string[];
}

export interface Publication {
  id: number;
  blogId: string;
  platformPostId: string;
  title: string;
  url: string;
  status: string;
  sourceUrls: string[];
  publishedAt: string | null;
  createdAt: string;
}

export interface DashboardBlog extends Blog {
  latestTitle: string | null;
  latestUrl: string | null;
  latestPublishedAt: string | null;
  views7d: number;
  viewsPrev7d: number;
  sessions7d: number;
  engagedSessions7d: number;
  momentumPercent: number | null;
  engagementRate: number | null;
  nativeComments: number;
  searchClicks: number;
  searchImpressions: number;
  searchCtrPercent: number | null;
  searchPosition: number | null;
  topSearchQuery: string | null;
  latestExperimentAxis: string | null;
  latestExperimentVariant: string | null;
  latestExperimentHypothesis: string | null;
  recentRuns: number;
  failedRuns: number;
}
