import { NextResponse } from "next/server";
import { encryptJson } from "@/lib/crypto";
import { createBlog, listBlogs, setBlogActive } from "@/lib/db";
import type { BlogPlatform, PublishMode } from "@/lib/types";

function csv(value: FormDataEntryValue | null): string[] {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
}

export async function GET() {
  return NextResponse.json(listBlogs().map(({ credentialsCipher, ...blog }) => blog));
}

export async function POST(request: Request) {
  const form = await request.formData();
  const platform = String(form.get("platform")) as BlogPlatform;
  if (!["wordpress", "ghost", "blogger"].includes(platform)) return new NextResponse("Unsupported platform", { status: 400 });
  const publishMode = String(form.get("publishMode")) as PublishMode;
  if (!["review", "auto"].includes(publishMode)) return new NextResponse("Invalid publishMode", { status: 400 });
  let credentials: unknown;
  try { credentials = JSON.parse(String(form.get("credentialsJson") || "{}")); }
  catch { return new NextResponse("credentialsJson must be valid JSON", { status: 400 }); }
  const blog = createBlog({
    name: String(form.get("name") || "").trim(),
    niche: String(form.get("niche") || "").trim(),
    platform,
    siteUrl: String(form.get("siteUrl") || "").replace(/\/$/, ""),
    keywords: csv(form.get("keywords")),
    feeds: csv(form.get("feeds")),
    credentialsCipher: encryptJson(credentials),
    publishMode,
    cadenceHours: Math.max(1, Number(form.get("cadenceHours") || 24)),
    dailyLimit: Math.max(1, Math.min(10, Number(form.get("dailyLimit") || 1))),
    language: "ja",
    timezone: "Asia/Tokyo",
    ga4PropertyId: String(form.get("ga4PropertyId") || "").trim() || null,
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
