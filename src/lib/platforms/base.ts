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

export interface ExistingPost {
  title: string;
  html: string;
  excerpt: string;
  updatedAt: string | null;
}

export interface PostUpdate {
  title?: string;
  html?: string;
  excerpt?: string;
}

export interface PostUpdateResult {
  url: string;
  updatedAt: string | null;
}

export interface BlogPlatformAdapter {
  validate(siteUrl: string, credentials: unknown): Promise<ValidationResult>;
  publish(blog: Blog, credentials: unknown, article: GeneratedArticle): Promise<PublishResult>;
  publishDraft(blog: Blog, credentials: unknown, publication: Publication): Promise<PublishResult>;
  readPost(blog: Blog, credentials: unknown, publication: Publication): Promise<ExistingPost>;
  updatePost(blog: Blog, credentials: unknown, publication: Publication, update: PostUpdate, existing: ExistingPost): Promise<PostUpdateResult>;
  collectReactions?(blog: Blog, credentials: unknown, publication: Publication): Promise<NativeReactionResult>;
}
