import { NextResponse } from "next/server";
import { contentRevisionOperationalSummary } from "@/lib/content-revisions";
import { runDiagnostics, type DiagnosticItem } from "@/lib/diagnostics";
import { recentOperationalIncidents } from "@/lib/incidents";

export const maxDuration = 300;

function revisionDiagnostic(): DiagnosticItem {
  const summary = contentRevisionOperationalSummary(15);
  if (summary.stalePrepared > 0) {
    return {
      scope: "system",
      label: "既存記事revision整合性",
      status: "error",
      detail: `15分以上preparedのままのrevisionが${summary.stalePrepared}件あります。独立monitorがCMS現在値を読取照合し、変更前/変更後どちらにも一致しない場合はCRITICAL incidentとして通知します${summary.oldestStalePreparedAt ? ` · oldest=${summary.oldestStalePreparedAt}` : ""}`,
    };
  }
  if (summary.failedRecent > 0) {
    return {
      scope: "system",
      label: "既存記事revision整合性",
      status: "warn",
      detail: `直近24時間にfailed revisionが${summary.failedRecent}件あります。外部変更に失敗した履歴でありrollback対象ではありません。ホームの要確認revisionから内容を確認できます`,
    };
  }
  return {
    scope: "system",
    label: "既存記事revision整合性",
    status: "ok",
    detail: "15分以上のstale preparedはなく、直近24時間のfailed revisionもありません",
  };
}

export async function POST() {
  const items = await runDiagnostics();
  items.push(revisionDiagnostic());
  const incidents = recentOperationalIncidents(20);
  const hasError = items.some((item) => item.status === "error");
  return NextResponse.json({ ok: !hasError, items, incidents });
}
