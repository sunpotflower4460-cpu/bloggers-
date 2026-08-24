import { NextResponse } from "next/server";
import { runDiagnostics } from "@/lib/diagnostics";

export const maxDuration = 300;

export async function POST() {
  const items = await runDiagnostics();
  const hasError = items.some((item) => item.status === "error");
  return NextResponse.json({ ok: !hasError, items });
}
