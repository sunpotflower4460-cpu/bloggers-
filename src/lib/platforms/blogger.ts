import { createHash } from "node:crypto";
import type { BloggerCredentials } from "../credentials";
import type { BlogPlatformAdapter } from "./base";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(c: BloggerCredentials): string {
  return createHash("sha256").update(`${c.clientId}\0${c.refreshToken}`).digest("hex");
}

async function accessToken(c: BloggerCredentials): Promise<string> {
  const key = cacheKey(c);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error(`Google token refresh failed ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const token = String(payload.access_token || "");
  if (!token) throw new Error("Google token refresh did not return access_token");
  const expiresIn = Math.max(120, Number(payload.expires_in || 3600));
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

function postEndpoint(credentials: BloggerCredentials, postId: string): string {
  return `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(credentials.blogId)}/posts/${encodeURIComponent(postId)}`;
}

export const bloggerAdapter: BlogPlatformAdapter = {
  async validate(_siteUrl, raw) {
    const credentials = raw as BloggerCredentials;
    if (!credentials.blogId) throw new Error("Blogger blogId is required");
    const token = await accessToken(credentials);
    const response = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(credentials.blogId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Blogger接続に失敗しました (${response.status})`);
    const blog = await response.json();
    return { label: "Bloggerに接続できました", detail: blog.name || blog.url || credentials.blogId };
  },
  async publish(blog, raw, article) {
    const credentials = raw as BloggerCredentials;
    if (!credentials.blogId) throw new Error("Blogger blogId is required");
    const token = await accessToken(credentials);
    const draft = blog.publishMode !== "auto";
    const endpoint = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(credentials.blogId)}/posts?isDraft=${draft}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: article.title, content: article.html, labels: article.tags.slice(0, 20) }),
    });
    if (!response.ok) throw new Error(`Blogger publish failed ${response.status}: ${await response.text()}`);
    const post = await response.json();
    return {
      platformPostId: String(post.id),
      url: post.url || blog.siteUrl,
      status: draft ? "draft" : "published",
      publishedAt: post.published || null,
    };
  },
  async readPost(_blog, raw, publication) {
    const credentials = raw as BloggerCredentials;
    const token = await accessToken(credentials);
    const response = await fetch(`${postEndpoint(credentials, publication.platformPostId)}?fetchBody=true&maxComments=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Blogger post read failed ${response.status}: ${await response.text()}`);
    const post = await response.json();
    return {
      title: String(post.title || publication.title),
      html: String(post.content || ""),
      excerpt: "",
      updatedAt: post.updated || null,
    };
  },
  async updatePost(_blog, raw, publication, update) {
    const credentials = raw as BloggerCredentials;
    const token = await accessToken(credentials);
    const body: Record<string, string> = {};
    if (update.title !== undefined) body.title = update.title;
    if (update.html !== undefined) body.content = update.html;
    const response = await fetch(postEndpoint(credentials, publication.platformPostId), {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Blogger update failed ${response.status}: ${await response.text()}`);
    const post = await response.json();
    return { url: post.url || publication.url, updatedAt: post.updated || null };
  },
  async collectReactions(_blog, raw, publication) {
    const credentials = raw as BloggerCredentials;
    const token = await accessToken(credentials);
    const response = await fetch(`${postEndpoint(credentials, publication.platformPostId)}?maxComments=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Blogger reactions failed ${response.status}`);
    const post = await response.json();
    return { comments: Number(post.replies?.totalItems || 0) };
  },
};
