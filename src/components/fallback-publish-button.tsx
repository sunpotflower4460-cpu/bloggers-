"use client";

import { useState } from "react";

export function FallbackPublishButton({ publicationId }: { publicationId: number }) {
  const [state, setState] = useState<"idle" | "publishing" | "busy" | "error">("idle");

  async function publishDraft() {
    if (!window.confirm("品質OKの下書きを外部ブログへ公開します。公開後は読者から見える状態になります。よろしいですか？")) return;
    setState("publishing");
    try {
      const response = await fetch("/api/reviews/fallback/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicationId, confirmPublish: true }),
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

  const label = state === "publishing"
    ? "公開中…"
    : state === "busy"
      ? "状態更新後に再確認"
      : state === "error"
        ? "公開を再試行"
        : "公開する";

  return (
    <button className="button" onClick={publishDraft} disabled={state === "publishing"}>
      {label}
    </button>
  );
}
