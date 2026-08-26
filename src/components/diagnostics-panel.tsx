"use client";

import { useState } from "react";
import type { DiagnosticItem } from "@/lib/diagnostics";
import type { OperationalIncidentSummary } from "@/lib/incidents";

function date(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function DiagnosticsPanel() {
  const [items, setItems] = useState<DiagnosticItem[]>([]);
  const [incidents, setIncidents] = useState<OperationalIncidentSummary[]>([]);
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
      setIncidents(Array.isArray(payload.incidents) ? payload.incidents : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const errors = items.filter((item) => item.status === "error").length;
  const openIncidents = incidents.filter((incident) => incident.status === "open").length;
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
      {items.length ? (
        <div className="latest">
          <span>INCIDENT HISTORY · OPEN {openIncidents}</span>
          <p>{incidents.length ? "最近の障害と復旧履歴" : "記録された障害はありません"}</p>
          <small>openを優先し、その後に最近復旧したものを表示します。通知先URLや資格情報は表示しません。</small>
        </div>
      ) : null}
      {incidents.map((incident) => (
        <div className="latest" key={`${incident.code}-${incident.scope}`}>
          <span>{incident.status.toUpperCase()} · {incident.severity.toUpperCase()} · {incident.scope}</span>
          <p>{incident.code}</p>
          <small>{incident.detail}</small>
          <small>発生 {date(incident.openedAt)} · 更新 {date(incident.updatedAt)} · 最終通知 {date(incident.lastNotifiedAt)}{incident.resolvedAt ? ` · 復旧 ${date(incident.resolvedAt)}` : ""}</small>
        </div>
      ))}
    </section>
  );
}
