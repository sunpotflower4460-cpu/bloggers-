import Link from "next/link";
import { DiagnosticsPanel } from "@/components/diagnostics-panel";

export default function DiagnosticsPage() {
  return (
    <main className="shell narrow">
      <Link href="/" className="back">← 庭へ戻る</Link>
      <header className="pageHead">
        <p className="eyebrow">GARDEN DIAGNOSTICS</p>
        <h1>庭の健康診断</h1>
        <p className="lead">自動運転を始める前や、記事が急に止まった時に、設定・DB・投稿先・Google連携を一括で確認します。</p>
      </header>
      <DiagnosticsPanel />
    </main>
  );
}
