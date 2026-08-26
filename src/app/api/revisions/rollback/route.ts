import { NextResponse } from "next/server";
import { ContentRollbackError, rollbackContentRevision } from "@/lib/content-rollback";

export const maxDuration = 120;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const revisionId = Number(body.revisionId);
  if (!Number.isInteger(revisionId) || revisionId <= 0) {
    return NextResponse.json({ error: "revisionId must be a positive integer" }, { status: 400 });
  }
  if (body.confirmRollback !== true) {
    return NextResponse.json({ error: "confirmRollback=true is required for an external rollback mutation" }, { status: 400 });
  }

  try {
    const result = await rollbackContentRevision(revisionId);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof ContentRollbackError) {
      const status = error.code === "not-found" ? 404 : error.code === "busy" || error.code === "conflict" || error.code === "not-eligible" ? 409 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
