import { NextResponse } from "next/server";
import { FallbackDraftPublishError, publishApprovedFallbackDraft } from "@/lib/fallback-publish";

export const maxDuration = 120;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const publicationId = Number(body.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return NextResponse.json({ error: "publicationId must be a positive integer" }, { status: 400 });
  }
  if (body.confirmPublish !== true) {
    return NextResponse.json({ error: "confirmPublish=true is required for an external publish mutation" }, { status: 400 });
  }

  try {
    const result = await publishApprovedFallbackDraft(publicationId);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof FallbackDraftPublishError) {
      const status = error.code === "busy" || error.code === "not-eligible" ? 409 : error.code === "blog-not-found" ? 404 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
