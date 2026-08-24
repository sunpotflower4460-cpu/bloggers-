import { createHmac } from "node:crypto";
import type { GhostCredentials } from "../credentials";
import type { BlogPlatformAdapter } from "./base";

function b64(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function token(key: string): string {
  const [id, secret] = key.split(":");
  if (!id || !secret) throw new Error("Ghost adminApiKey must be id:secret");
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const body = b64(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }));
  const unsigned = `${head}.${body}`;
  const sig = createHmac("sha256", Buffer.from(secret, "hex")).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

function headers(credentials: GhostCredentials) {
  return { "accept-version": "v5.0", authorization: `Ghost ${token(credentials.adminApiKey)}` };
}

export const ghostAdapter: BlogPlatformAdapter = {
  async validate(siteUrl, raw) {
    const credentials = raw as GhostCredentials;
    const endpoint = `${siteUrl.replace(/\/$/, "")}/ghost/api/admin/site/`;
    const response = await fetch(endpoint, { headers: headers(credentials) });
    if (!response.ok) throw new Error(`Ghost接続に失敗しました (${response.status})`);
    const site = await response.json();
    return { label: "Ghostに接続できました", detail: site.title || site.url || siteUrl };
  },
  async publish(blog, raw, article) {
    const credentials = raw as GhostCredentials;
    const endpoint = `${blog.siteUrl.replace(/\/$/, "")}/ghost/api/admin/posts/?source=html`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers(credentials) },
      body: JSON.stringify({ posts: [{
        title: article.title,
        html: article.html,
        custom_excerpt: article.excerpt,
        tags: article.tags,
        status: blog.publishMode === "auto" ? "published" : "draft",
      }] }),
    });
    if (!response.ok) throw new Error(`Ghost publish failed ${response.status}: ${await response.text()}`);
    const post = (await response.json()).posts?.[0];
    return {
      platformPostId: String(post.id),
      url: post.url || blog.siteUrl,
      status: blog.publishMode === "auto" ? "published" : "draft",
      publishedAt: post.published_at || null,
    };
  },
};
