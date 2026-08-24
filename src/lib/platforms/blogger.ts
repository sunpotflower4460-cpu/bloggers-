import type { BloggerCredentials } from "../credentials";
import type { BlogPlatformAdapter } from "./base";

async function accessToken(c: BloggerCredentials): Promise<string> {
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
  return (await response.json()).access_token;
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
};
