"use client";

import { useState } from "react";

type Outcome = "quality-ok" | "needs-improvement";

export function FallbackReviewButton({ publicationId }: { publicationId: number }) {
  const [saving, setSaving] = useState<Outcome | null>(null);
  const [error, setError] = useState(false);

  async function review(outcome: Outcome) {
    setSaving(outcome);
    setError(false);
    try {
      const response = await fetch("/api/reviews/fallback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicationId, outcome }),
      });
      if (!response.ok) throw new Error(await response.text());
      location.reload();
    } catch {
      setSaving(null);
      setError(true);
    }
  }

  return (
    <div className="actions">
      <button className="button" onClick={() => review("quality-ok")} disabled={saving !== null}>
        {saving === "quality-ok" ? "記録中…" : "品質OK"}
      </button>
      <button className="button secondary" onClick={() => review("needs-improvement")} disabled={saving !== null}>
        {saving === "needs-improvement" ? "記録中…" : error ? "要改善を再記録" : "要改善"}
      </button>
    </div>
  );
}
