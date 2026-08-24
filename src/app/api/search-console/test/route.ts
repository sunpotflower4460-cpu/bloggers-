import { NextResponse } from "next/server";
import { testSearchConsole } from "@/lib/analytics/search-console";

function propertyFrom(value: FormDataEntryValue | null): string {
  const site = String(value || "").trim();
  if (!site) throw new Error("Search Console Property を入力してください");
  if (site.startsWith("sc-domain:") && site.length > "sc-domain:".length) return site;
  const url = new URL(site);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Search Console Property が正しくありません");
  return site;
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const site = propertyFrom(form.get("searchConsoleSiteUrl"));
    const result = await testSearchConsole(site);
    return NextResponse.json({
      ok: true,
      label: "Search Console 接続OK",
      detail: result.rows > 0 ? "検索データを読み取れました" : "権限は確認できました。対象期間の検索データはまだ0件です",
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
