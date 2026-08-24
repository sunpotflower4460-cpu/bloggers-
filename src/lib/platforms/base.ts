import type { Blog, GeneratedArticle, Publication } from "../types";

export interface PublishResult {
  platformPostId: string;
  url: string;
  status: "draft" | "published";
  publishedAt: string | null;
}

export interface ValidationResult {
  label: string;
  detail?: string;
}

export interface NativeReactionResult {
  comments: number;
}

export interface BlogPlatformAdapter {
  validate(siteUrl: string, credentials: unknown): Promise<ValidationResult>;
  publish(blog: Blog, credentials: unknown, article: GeneratedArticle): Promise<PublishResult>;
  collectReactions?(blog: Blog, credentials: unknown, publication: Publication): Promise<NativeReactionResult>;
}
