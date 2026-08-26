import { NextResponse } from "next/server";
import {
  ContentRevisionResolveError,
  resolveContentRevisionAcceptCurrent,
} from "@/lib/content-revision-resolve";
import { runOperationalMonitor } from "@/lib/ops-monitor";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const revisionId = Number(body.revisionId);
  if (!Number.isInteger(revisionId) || revisionId <= 0) {
    return NextResponse.json({ error: "revisionId must be a positive integer" }, { status: 400 });
  }
  if (body.confirmResolve !== true) {
    return NextResponse.json({ error: "confirmResolve=true is required for human uncertainty resolution" }, { status: 400 });
  }
  const reason = String(body.reason || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (reason.length < 4) {
    return NextResponse.json({ error: "reason must contain at least 4 characters" }, { status: 400 });
  }

  try {
    const result = await resolveContentRevisionAcceptCurrent(revisionId, reason);
    let monitorSynced = false;
    try {
      // If F-052 already opened a persistent uncertainty incident, the normal
      // monitor lifecycle now observes that the revision is no longer prepared
      // and emits/closes it as RECOVERY. This remains read-only against the CMS.
      await runOperationalMonitor();
      monitorSynced = true;
    } catch {
      // The explicit local resolution is already durably complete. A separate
      // monitor failure must not misreport it as rolled back or undone.
    }
    return NextResponse.json({ ok: true, result, monitorSynced });
  } catch (error) {
    if (error instanceof ContentRevisionResolveError) {
      const status = error.code === "busy" || error.code === "not-eligible" ? 409 : 404;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
