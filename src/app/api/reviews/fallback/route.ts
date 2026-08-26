import { NextResponse } from "next/server";
import { recordFallbackReviewOutcome, type FallbackReviewOutcome } from "@/lib/fallback-review";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const publicationId = Number(body.publicationId);
  const outcome = String(body.outcome || "") as FallbackReviewOutcome;
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return NextResponse.json({ error: "publicationId must be a positive integer" }, { status: 400 });
  }
  if (outcome !== "quality-ok" && outcome !== "needs-improvement") {
    return NextResponse.json({ error: "outcome must be quality-ok or needs-improvement" }, { status: 400 });
  }
  recordFallbackReviewOutcome(publicationId, outcome);
  return NextResponse.json({ ok: true, outcome });
}
