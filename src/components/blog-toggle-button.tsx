"use client";

import { useState } from "react";

export function BlogToggleButton({ blogId, active }: { blogId: string; active: boolean }) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const response = await fetch("/api/blogs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: blogId, active: !active }),
      });
      if (!response.ok) throw new Error(await response.text());
      location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="button secondary compact" type="button" onClick={toggle} disabled={busy}>
      {busy ? "変更中…" : active ? "自動運転を停止" : "自動運転を再開"}
    </button>
  );
}
