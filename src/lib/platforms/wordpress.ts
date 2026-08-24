import type { WordPressCredentials } from "../credentials";
import type { BlogPlatformAdapter } from "./base";

function auth(credentials: WordPressCredentials): string {
  if (!credentials.username || !credentials.applicationPassword) throw new Error("WordPress credentials are incomplete");
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.applicationPassword}`).toString("base64")}`;
}

export const wordpressAdapter: BlogPlatformAdapter = {
  async validate(siteUrl, raw) {
    const credentials = raw as WordPressCredentials;
    const endpoint = `${siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/users/me?context=edit`;
    const response = await fetch(endpoint, { headers: { authorization: auth(credentials) } });
    if (!response.ok) throw new Error(`WordPress接続に失敗しました (${response.status})`);
    const user = await response.json();
    return { label: "WordPressに接続できました", detail: user.name || user.slug || credentials.username };
  },
  async publish(blog, raw, article) {
    const credentials = raw as WordPressCredentials;
    const endpoint = `${blog.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth(credentials),
      },
      body: JSON.stringify({
        title: article.title,
        content: article.html,
        excerpt: article.excerpt,
        status: blog.publishMode === "auto" ? "publish" : "draft",
      }),
    });
    if (!response.ok) throw new Error(`WordPress publish failed ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    return {
      platformPostId: String(payload.id),
      url: payload.link || blog.siteUrl,
      status: blog.publishMode === "auto" ? "published" : "draft",
      publishedAt: payload.date_gmt ? new Date(`${payload.date_gmt}Z`).toISOString() : null,
    };
  },
};
