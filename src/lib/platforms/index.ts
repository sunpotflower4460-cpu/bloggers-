import type { BlogPlatform } from "../types";
import { secureGeneratedArticle } from "../article-safety";
import type { BlogPlatformAdapter } from "./base";
import { bloggerAdapter } from "./blogger";
import { ghostAdapter } from "./ghost";
import { wordpressAdapter } from "./wordpress";

const adapters: Record<BlogPlatform, BlogPlatformAdapter> = {
  wordpress: wordpressAdapter,
  ghost: ghostAdapter,
  blogger: bloggerAdapter,
};

export function platformAdapter(platform: BlogPlatform): BlogPlatformAdapter {
  const adapter = adapters[platform];
  return {
    ...adapter,
    publish: (blog, credentials, article) => adapter.publish(blog, credentials, secureGeneratedArticle(article)),
  };
}
