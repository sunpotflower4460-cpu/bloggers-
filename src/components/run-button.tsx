"use client";

import { useState } from "react";

type RunState = "idle" | "running" | "done" | "busy" | "budget" | "error";

export function RunButton({ blogId }: { blogId?: string }) {
  const [state, setState] = useState<RunState>("idle");
  async function run() {
    setState("running");
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blogId }),
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json() as { results?: Array<{ status?: string }> };
      const results = payload.results || [];
      if (results.some((result) => result.status === "busy")) {
        setState("busy");
        return;
      }
      if (results.length > 0 && results.every((result) => result.status === "budget-blocked")) {
        setState("budget");
        return;
      }
      setState("done");
      location.reload();
    } catch {
      setState("error");
    }
  }
  const label = state === "running"
    ? "育成中…"
    : state === "busy"
      ? "別の育成が実行中"
      : state === "budget"
        ? "AI予算上限で保護停止"
        : state === "error"
          ? "再実行"
          : "今すぐ育てる";
  return <button className="button" onClick={run} disabled={state === "running"}>{label}</button>;
}
