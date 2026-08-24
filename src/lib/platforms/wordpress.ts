import type { BlogPlatformAdapter } from "./base";

interface WordPressCredentials {
  username: string;
  applicationPassword: string;
}

export const wordpressAdapter: BlogPlatformAdapter = {
  async publish(blog, raw, article) {
    const credentials = raw as WordPressCredentials;
    if (!credentials.username || !credentials.applicationPassword) throw new Error("WordPress credentials are incomplete");
    const endpoint = `${blog.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.applicationPassword}`).toString("base64")}`,
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
