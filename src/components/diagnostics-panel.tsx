"use client";

import { useState } from "react";
import type { DiagnosticItem } from "@/lib/diagnostics";

export function DiagnosticsPanel() {
  const [items, setItems] = useState<DiagnosticItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/diagnostics", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.items)) throw new Error(payload.error || "診断を実行できませんでした");
      setItems(payload.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const errors = items.filter((item) => item.status === "error").length;
  return (
    <section className="setupForm">
      <div className="formNotice">
        <strong>{items.length ? (errors ? `${errors}件の要確認` : "すべて正常") : "未診断"}</strong>
        <span>外部ブログとSearch Consoleには読み取り接続しますが、記事の投稿や変更は行いません。</span>
      </div>
      <button className="button large" type="button" onClick={run} disabled={running}>{running ? "診断中…" : "庭全体を診断"}</button>
      {error ? <p className="connectionMessage error">{error}</p> : null}
      {items.map((item, index) => (
        <div className="latest" key={`${item.scope}-${item.label}-${index}`}>
          <span>{item.scope} · {item.status.toUpperCase()}</span>
          <p>{item.label}</p>
          <small>{item.detail}</small>
        </div>
      ))}
    </section>
  );
}
