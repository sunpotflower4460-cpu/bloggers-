"use client";

import { useState } from "react";

export function ContentRevisionResolveButton({ revisionId }: { revisionId: number }) {
  const [state, setState] = useState<"idle" | "resolving" | "busy" | "error">("idle");

  async function resolveRevision() {
    const reason = window.prompt(
      "現在の外部CMS記事を確認した上で、その状態を正として不確定revisionを閉じます。監査用に確認理由を入力してください。",
      "現在のCMS内容を確認し、この状態を正として受け入れた",
    );
    if (reason === null) return;
    const cleanReason = reason.replace(/\s+/g, " ").trim();
    if (cleanReason.length < 4) {
      setState("error");
      return;
    }
    if (!window.confirm("外部CMSは書き換えません。現在のCMS状態をsnapshotとして保存し、Blog Garden側の不確定状態だけを解決します。よろしいですか？")) return;

    setState("resolving");
    try {
      const response = await fetch("/api/revisions/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId, reason: cleanReason, confirmResolve: true }),
      });
      if (response.status === 409) {
        setState("busy");
        return;
      }
      if (!response.ok) throw new Error(await response.text());
      location.reload();
    } catch {
      setState("error");
    }
  }

  const label = state === "resolving"
    ? "確認状態を保存中…"
    : state === "busy"
      ? "現在状態を再確認"
      : state === "error"
        ? "解決を再試行"
        : "現在のCMS状態を正として解決";

  return (
    <button className="button" onClick={resolveRevision} disabled={state === "resolving"}>
      {label}
    </button>
  );
}
