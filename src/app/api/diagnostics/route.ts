import { NextResponse } from "next/server";
import { runDiagnostics } from "@/lib/diagnostics";
import { recentOperationalIncidents } from "@/lib/incidents";

export const maxDuration = 300;

export async function POST() {
  const items = await runDiagnostics();
  const incidents = recentOperationalIncidents(20);
  const hasError = items.some((item) => item.status === "error");
  return NextResponse.json({ ok: !hasError, items, incidents });
}
