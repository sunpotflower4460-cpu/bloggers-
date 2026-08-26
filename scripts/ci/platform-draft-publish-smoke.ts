import { bloggerAdapter } from "../../src/lib/platforms/blogger";
import { ghostAdapter } from "../../src/lib/platforms/ghost";
import { wordpressAdapter } from "../../src/lib/platforms/wordpress";
import type { Blog, Publication } from "../../src/lib/types";

const publication: Publication = {
  id: 1,
  blogId: "blog-1",
  platformPostId: "post-1",
  title: "Reviewed draft",
  url: "https://example.test/draft",
  status: "draft",
  sourceUrls: [],
  publishedAt: null,
  createdAt: new Date().toISOString(),
};

function blog(platform: Blog["platform"], siteUrl: string): Blog {
  return {
    id: "blog-1",
    name: "Test Blog",
    niche: "test",
    platform,
    siteUrl,
    keywords: ["test"],
    feeds: [],
    credentialsCipher: "unused",
    publishMode: "review",
    cadenceHours: 24,
    dailyLimit: 1,
    language: "ja",
    timezone: "Asia/Tokyo",
    ga4PropertyId: null,
    searchConsoleSiteUrl: null,
    active: true,
    lastRunAt: null,
    createdAt: new Date().toISOString(),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const originalFetch = globalThis.fetch;

try {
  {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    let step = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method || "GET", body: String(init?.body || "") });
      step += 1;
      if (step === 1) return jsonResponse({ status: "draft", link: "https://wp.test/?p=1", date_gmt: null });
      if (step === 2) return jsonResponse({ status: "publish", link: "https://wp.test/reviewed-draft", date_gmt: "2026-08-26T06:10:00" });
      throw new Error("unexpected WordPress fetch");
    };

    const result = await wordpressAdapter.publishDraft(
      blog("wordpress", "https://wp.test"),
      { username: "editor", applicationPassword: "app-password" },
      publication,
    );
    if (result.status !== "published" || calls.length !== 2) throw new Error("WordPress explicit draft publish failed");
    if (!calls[0].url.includes("?context=edit") || calls[0].method !== "GET") throw new Error("WordPress did not re-read live draft state");
    if (calls[1].method !== "POST") throw new Error("WordPress publish mutation must use POST update");
    const body = JSON.parse(calls[1].body);
    if (JSON.stringify(body) !== JSON.stringify({ status: "publish" })) {
      throw new Error(`WordPress publish mutation overwrote content: ${calls[1].body}`);
    }
  }

  {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    let step = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method || "GET", body: String(init?.body || "") });
      step += 1;
      if (step === 1) {
        return jsonResponse({ posts: [{
          id: "post-1",
          status: "draft",
          updated_at: "2026-08-26T06:00:00.000Z",
          url: "https://ghost.test/reviewed-draft",
        }] });
      }
      if (step === 2) {
        return jsonResponse({ posts: [{
          id: "post-1",
          status: "published",
          updated_at: "2026-08-26T06:10:00.000Z",
          published_at: "2026-08-26T06:10:00.000Z",
          url: "https://ghost.test/reviewed-draft",
        }] });
      }
      throw new Error("unexpected Ghost fetch");
    };

    const result = await ghostAdapter.publishDraft(
      blog("ghost", "https://ghost.test"),
      { adminApiKey: `test-id:${"11".repeat(32)}` },
      publication,
    );
    if (result.status !== "published" || calls.length !== 2) throw new Error("Ghost explicit draft publish failed");
    if (!calls[0].url.includes("?formats=html") || calls[0].method !== "GET") throw new Error("Ghost did not re-read live draft state");
    if (calls[1].method !== "PUT" || !calls[1].url.includes("save_revision=true")) throw new Error("Ghost publish did not preserve revision safety");
    const body = JSON.parse(calls[1].body);
    const post = body.posts?.[0];
    if (!post || post.updated_at !== "2026-08-26T06:00:00.000Z" || post.status !== "published" || Object.keys(post).sort().join(",") !== "status,updated_at") {
      throw new Error(`Ghost publish mutation included unsafe fields: ${calls[1].body}`);
    }
  }

  {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    let step = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method || "GET", body: String(init?.body || "") });
      step += 1;
      if (step === 1) return jsonResponse({ access_token: "blogger-test-token", expires_in: 3600 });
      if (step === 2) return jsonResponse({ id: "post-1", status: "DRAFT", url: "https://blogger.test/draft" });
      if (step === 3) return jsonResponse({ id: "post-1", status: "LIVE", url: "https://blogger.test/live", published: "2026-08-26T06:10:00.000Z" });
      throw new Error("unexpected Blogger fetch");
    };

    const result = await bloggerAdapter.publishDraft(
      blog("blogger", "https://blogger.test"),
      { clientId: "client", clientSecret: "secret", refreshToken: "refresh", blogId: "123" },
      publication,
    );
    if (result.status !== "published" || calls.length !== 3) throw new Error("Blogger explicit draft publish failed");
    if (!calls[1].url.includes("view=ADMIN") || calls[1].method !== "GET") throw new Error("Blogger did not re-read ADMIN draft status");
    if (!calls[2].url.endsWith("/posts/post-1/publish") || calls[2].method !== "POST") throw new Error(`Blogger did not use posts.publish endpoint: ${JSON.stringify(calls[2])}`);
    if (calls[2].body) throw new Error("Blogger posts.publish unexpectedly sent article body");
  }

  console.log(JSON.stringify({ ok: true, platforms: ["wordpress", "ghost", "blogger"] }));
} finally {
  globalThis.fetch = originalFetch;
}
