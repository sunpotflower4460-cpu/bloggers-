import type { Blog, GeneratedArticle } from "../types";

export interface PublishResult {
  platformPostId: string;
  url: string;
  status: "draft" | "published";
  publishedAt: string | null;
}

export interface BlogPlatformAdapter {
  publish(blog: Blog, credentials: unknown, article: GeneratedArticle): Promise<PublishResult>;
}
