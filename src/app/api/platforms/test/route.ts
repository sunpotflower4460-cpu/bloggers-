import { NextResponse } from "next/server";
import { credentialsFromForm } from "@/lib/credentials";
import { platformAdapter } from "@/lib/platforms";
import type { BlogPlatform } from "@/lib/types";

export async function POST(request: Request) {
  const form = await request.formData();
  const platform = String(form.get("platform")) as BlogPlatform;
  const siteUrl = String(form.get("siteUrl") || "").trim().replace(/\/$/, "");
  if (!["wordpress", "ghost", "blogger"].includes(platform)) return new NextResponse("Unsupported platform", { status: 400 });
  if (!siteUrl) return new NextResponse("ブログURLを入力してください", { status: 400 });

  try {
    const credentials = credentialsFromForm(form, platform);
    const result = await platformAdapter(platform).validate(siteUrl, credentials);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
