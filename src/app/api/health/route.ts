import { NextResponse } from "next/server";
import { listBlogs } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    listBlogs();
    const required = ["APP_ENCRYPTION_KEY", "AI_API_KEY", "AI_MODEL"];
    if (process.env.NODE_ENV === "production") required.push("ADMIN_USERNAME", "ADMIN_PASSWORD");
    if (required.some((key) => !process.env[key])) {
      return NextResponse.json({ status: "degraded" }, { status: 503 });
    }
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
