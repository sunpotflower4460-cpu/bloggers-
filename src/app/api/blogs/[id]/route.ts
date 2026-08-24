import { NextResponse } from "next/server";
import { credentialsFromForm, hasCredentialInput } from "@/lib/credentials";
import { encryptJson } from "@/lib/crypto";
import { getBlog, updateBlog } from "@/lib/db";
import type { PublishMode } from "@/lib/types";

function csv(value: FormDataEntryValue | null): string[] {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const current = getBlog(id);
  if (!current) return new NextResponse("Blog not found", { status: 404 });

  const form = await request.formData();
  const publishMode = String(form.get("publishMode") || "") as PublishMode;
  if (!["review", "auto"].includes(publishMode)) return new NextResponse("Invalid publishMode", { status: 400 });
  const name = String(form.get("name") || "").trim();
  const niche = String(form.get("niche") || "").trim();
  const siteUrl = String(form.get("siteUrl") || "").trim().replace(/\/$/, "");
  const keywords = csv(form.get("keywords"));
  if (!name || !niche || !siteUrl || !keywords.length) return new NextResponse("必須項目が不足しています", { status: 400 });
  try { new URL(siteUrl); } catch { return new NextResponse("ブログURLが正しくありません", { status: 400 }); }

  let credentialsCipher: string | undefined;
  if (hasCredentialInput(form, current.platform)) {
    try { credentialsCipher = encryptJson(credentialsFromForm(form, current.platform)); }
    catch (error) { return new NextResponse(error instanceof Error ? error.message : String(error), { status: 400 }); }
  }

  const updated = updateBlog(id, {
    name,
    niche,
    siteUrl,
    keywords,
    feeds: csv(form.get("feeds")),
    credentialsCipher,
    publishMode,
    cadenceHours: Math.max(1, Number(form.get("cadenceHours") || 24)),
    dailyLimit: Math.max(1, Math.min(10, Number(form.get("dailyLimit") || 1))),
    ga4PropertyId: String(form.get("ga4PropertyId") || "").trim() || null,
  });
  if (!updated) return new NextResponse("Blog not found", { status: 404 });
  return NextResponse.redirect(new URL("/", request.url), 303);
}
