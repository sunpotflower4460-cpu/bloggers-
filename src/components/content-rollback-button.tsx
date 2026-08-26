"use client";

import { useState } from "react";

export function ContentRollbackButton({ revisionId }: { revisionId: number }) {
  const [state, setState] = useState<"idle" | "rolling-back" | "conflict" | "error">("idle");

  async function rollback() {
    if (!window.confirm("この自動改善を変更前の状態へ戻します。外部ブログを更新します。現在の記事が自動改善後の状態と一致しない場合は、人間編集を守るため自動的に中止します。よろしいですか？")) return;
    setState("rolling-back");
    try {
      const response = await fetch("/api/revisions/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId, confirmRollback: true }),
      });
      if (response.status === 409) {
        setState("conflict");
        return;
      }
      if (!response.ok) throw new Error(await response.text());
      location.reload();
    } catch {
      setState("error");
    }
  }

  const label = state === "rolling-back"
    ? "戻しています…"
    : state === "conflict"
      ? "現在状態を再確認"
      : state === "error"
        ? "rollbackを再試行"
        : "変更前へ戻す";

  return (
    <button className="button secondary" onClick={rollback} disabled={state === "rolling-back"}>
      {label}
    </button>
  );
}
