import { NextResponse } from "next/server";
import { credentialsFromForm, hasCredentialInput } from "@/lib/credentials";
import { decryptJson } from "@/lib/crypto";
import { getBlog } from "@/lib/db";
import { platformAdapter } from "@/lib/platforms";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const blog = getBlog(id);
  if (!blog) return new NextResponse("Blog not found", { status: 404 });
  const form = await request.formData();
  const siteUrl = String(form.get("siteUrl") || blog.siteUrl).trim().replace(/\/$/, "");

  try {
    const credentials = hasCredentialInput(form, blog.platform)
      ? credentialsFromForm(form, blog.platform)
      : decryptJson<unknown>(blog.credentialsCipher);
    const result = await platformAdapter(blog.platform).validate(siteUrl, credentials);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
