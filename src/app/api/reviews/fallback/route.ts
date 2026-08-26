import { NextResponse } from "next/server";
import { markFallbackReviewReviewed } from "@/lib/fallback-review";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const publicationId = Number(body.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return NextResponse.json({ error: "publicationId must be a positive integer" }, { status: 400 });
  }
  markFallbackReviewReviewed(publicationId);
  return NextResponse.json({ ok: true });
}
