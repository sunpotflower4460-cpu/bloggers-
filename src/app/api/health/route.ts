import { NextResponse } from "next/server";
import { listBlogs } from "@/lib/db";

export async function GET() {
  return NextResponse.json({ ok: true, blogs: listBlogs().length, at: new Date().toISOString() });
}
