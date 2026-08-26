import { NextResponse } from "next/server";
import { runGarden } from "@/lib/engine";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const results = await runGarden(
    typeof body.blogId === "string" ? body.blogId : undefined,
    { force: true },
  );
  return NextResponse.json({ results });
}
