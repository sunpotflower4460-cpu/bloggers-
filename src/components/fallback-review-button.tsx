"use client";

import { useState } from "react";

export function FallbackReviewButton({ publicationId }: { publicationId: number }) {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  async function markReviewed() {
    setState("saving");
    try {
      const response = await fetch("/api/reviews/fallback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicationId }),
      });
      if (!response.ok) throw new Error(await response.text());
      location.reload();
    } catch {
      setState("error");
    }
  }

  return (
    <button className="button secondary" onClick={markReviewed} disabled={state === "saving"}>
      {state === "saving" ? "記録中…" : state === "error" ? "再試行" : "確認済みにする"}
    </button>
  );
}
