import { NextResponse } from "next/server";
import { credentialsFromForm } from "@/lib/credentials";
import { encryptJson } from "@/lib/crypto";
import { createBlog, listBlogs, setBlogActive } from "@/lib/db";
import type { BlogPlatform, PublishMode } from "@/lib/types";

function csv(value: FormDataEntryValue | null): string[] {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function platformFrom(value: FormDataEntryValue | null): BlogPlatform | null {
  const platform = String(value || "");
  return ["wordpress", "ghost", "blogger"].includes(platform) ? platform as BlogPlatform : null;
}

function publishModeFrom(value: FormDataEntryValue | null): PublishMode | null {
  const mode = String(value || "");
  return ["review", "auto"].includes(mode) ? mode as PublishMode : null;
}

function searchConsoleSiteFrom(value: FormDataEntryValue | null): string | null {
  const site = String(value || "").trim();
  if (!site) return null;
  if (site.startsWith("sc-domain:") && site.length > "sc-domain:".length) return site;
  const url = new URL(site);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Search Console property が正しくありません");
  return site;
}

export async function GET() {
  return NextResponse.json(listBlogs().map(({ credentialsCipher, ...blog }) => blog));
}

export async function POST(request: Request) {
  const form = await request.formData();
  const platform = platformFrom(form.get("platform"));
  if (!platform) return new NextResponse("Unsupported platform", { status: 400 });
  const publishMode = publishModeFrom(form.get("publishMode"));
  if (!publishMode) return new NextResponse("Invalid publishMode", { status: 400 });

  const name = String(form.get("name") || "").trim();
  const niche = String(form.get("niche") || "").trim();
  const siteUrl = String(form.get("siteUrl") || "").trim().replace(/\/$/, "");
  const keywords = csv(form.get("keywords"));
  if (!name || !niche || !siteUrl || !keywords.length) return new NextResponse("必須項目が不足しています", { status: 400 });
  try { new URL(siteUrl); } catch { return new NextResponse("ブログURLが正しくありません", { status: 400 }); }

  let credentials: unknown;
  try { credentials = credentialsFromForm(form, platform); }
  catch (error) { return new NextResponse(error instanceof Error ? error.message : String(error), { status: 400 }); }

  let searchConsoleSiteUrl: string | null;
  try { searchConsoleSiteUrl = searchConsoleSiteFrom(form.get("searchConsoleSiteUrl")); }
  catch (error) { return new NextResponse(error instanceof Error ? error.message : String(error), { status: 400 }); }

  createBlog({
    name,
    niche,
    platform,
    siteUrl,
    keywords,
    feeds: csv(form.get("feeds")),
    credentialsCipher: encryptJson(credentials),
    publishMode,
    cadenceHours: Math.max(1, Number(form.get("cadenceHours") || 24)),
    dailyLimit: Math.max(1, Math.min(10, Number(form.get("dailyLimit") || 1))),
    language: "ja",
    timezone: "Asia/Tokyo",
    ga4PropertyId: String(form.get("ga4PropertyId") || "").trim() || null,
    searchConsoleSiteUrl,
    active: true,
  });
  return NextResponse.redirect(new URL("/", request.url), 303);
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null) as { id?: unknown; active?: unknown } | null;
  if (!body || typeof body.id !== "string" || typeof body.active !== "boolean") {
    return new NextResponse("Expected { id: string, active: boolean }", { status: 400 });
  }
  const blog = setBlogActive(body.id, body.active);
  if (!blog) return new NextResponse("Blog not found", { status: 404 });
  const { credentialsCipher, ...safe } = blog;
  return NextResponse.json(safe);
}
