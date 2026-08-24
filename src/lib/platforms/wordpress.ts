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
      headers: { "content-type": "application/json", authorization: auth(credentials) },
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
  async readPost(blog, raw, publication) {
    const credentials = raw as WordPressCredentials;
    const endpoint = `${blog.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts/${encodeURIComponent(publication.platformPostId)}?context=edit`;
    const response = await fetch(endpoint, { headers: { authorization: auth(credentials) } });
    if (!response.ok) throw new Error(`WordPress post read failed ${response.status}: ${await response.text()}`);
    const post = await response.json();
    return {
      title: String(post.title?.raw || post.title?.rendered || publication.title),
      html: String(post.content?.raw || post.content?.rendered || ""),
      excerpt: String(post.excerpt?.raw || post.excerpt?.rendered || ""),
      updatedAt: post.modified_gmt ? new Date(`${post.modified_gmt}Z`).toISOString() : null,
    };
  },
  async updatePost(blog, raw, publication, update) {
    const credentials = raw as WordPressCredentials;
    const endpoint = `${blog.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts/${encodeURIComponent(publication.platformPostId)}`;
    const body: Record<string, string> = {};
    if (update.title !== undefined) body.title = update.title;
    if (update.html !== undefined) body.content = update.html;
    if (update.excerpt !== undefined) body.excerpt = update.excerpt;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth(credentials) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`WordPress update failed ${response.status}: ${await response.text()}`);
    const post = await response.json();
    return {
      url: post.link || publication.url,
      updatedAt: post.modified_gmt ? new Date(`${post.modified_gmt}Z`).toISOString() : null,
    };
  },
  async collectReactions(blog, raw, publication) {
    const credentials = raw as WordPressCredentials;
    const endpoint = new URL(`${blog.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/comments`);
    endpoint.searchParams.set("post", publication.platformPostId);
    endpoint.searchParams.set("status", "approve");
    endpoint.searchParams.set("per_page", "1");
    endpoint.searchParams.set("_fields", "id");
    const response = await fetch(endpoint, { headers: { authorization: auth(credentials) } });
    if (!response.ok) throw new Error(`WordPress comments failed ${response.status}`);
    return { comments: Number(response.headers.get("x-wp-total") || 0) };
  },
};
