"use client";

import { useState } from "react";

export function RunButton({ blogId }: { blogId?: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  async function run() {
    setState("running");
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blogId }),
      });
      if (!response.ok) throw new Error(await response.text());
      setState("done");
      location.reload();
    } catch {
      setState("error");
    }
  }
  return <button className="button" onClick={run} disabled={state === "running"}>{state === "running" ? "育成中…" : state === "error" ? "再実行" : "今すぐ育てる"}</button>;
}
