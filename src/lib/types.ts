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

export interface ArticlePlan {
  sourceUrl: string;
  angle: string;
  audience: string;
  reason: string;
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
  recentRuns: number;
  failedRuns: number;
}
