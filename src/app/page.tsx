import Link from "next/link";
import { perBlogBudgetHomeSnapshot, type PerBlogBudgetHomeScope } from "@/lib/ai-per-blog-budget-home";
import { globalAiBudgetProtection, globalAiBudgetWarning } from "@/lib/ai-budget-home";
import { aiEfficiencyPanel, type BlogAiEfficiencyObservation } from "@/lib/ai-efficiency";
import { dashboard, experimentContext } from "@/lib/db";
import { fallbackApprovedPublishQueue, fallbackQualitySummaries, fallbackReviewQueue } from "@/lib/fallback-review";
import { openOperationalIncidentsByCode } from "@/lib/incidents";
import { latestContentRefresh } from "@/lib/refresh-store";
import { BlogToggleButton } from "@/components/blog-toggle-button";
import { FallbackPublishButton } from "@/components/fallback-publish-button";
import { FallbackReviewButton } from "@/components/fallback-review-button";
import { RunButton } from "@/components/run-button";

export const dynamic = "force-dynamic";

function date(value: string | null) {
  if (!value) return "まだなし";
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function momentum(value: number | null) {
  if (value === null) return "new";
  return `${value > 0 ? "+" : ""}${value}%`;
}

function latestExperiment(blogId: string): string | null {
  const memory = experimentContext(blogId);
  if (memory.startsWith("まだ編集実験")) return null;
  return memory.split("\n")[0]?.replace(/^1\.\s*/, "") || null;
}

function refreshResult(outcome: string | null) {
  if (outcome === "win") return "改善あり";
  if (outcome === "loss") return "悪化";
  if (outcome === "inconclusive") return "判定保留";
  return "観測中";
}

function qualitySignal(value: "insufficient-sample" | "strong" | "mixed" | "weak") {
  if (value === "strong") return "高評価傾向";
  if (value === "mixed") return "評価が混在";
  if (value === "weak") return "要改善傾向";
  return "サンプル不足";
}

function money(value: number, currency: string) {
  const digits = Math.abs(value) < 1 ? 4 : 2;
  return `${currency} ${value.toFixed(digits)}`;
}

function aiCostLabel(observation: BlogAiEfficiencyObservation, panel: ReturnType<typeof aiEfficiencyPanel>) {
  if (panel.priceError) return "設定エラー";
  if (!panel.priceConfigured || observation.aiEstimatedCost7d === null) return "単価未設定";
  return money(observation.aiEstimatedCost7d, panel.currency);
}

function aiCoverageLabel(observation: BlogAiEfficiencyObservation, panel: ReturnType<typeof aiEfficiencyPanel>) {
  if (panel.priceError) return `価格設定エラー: ${panel.priceError}`;
  if (!panel.priceConfigured) return "AI_PRICE_TABLE_JSON未設定。callsは追跡しますが金額は推定しません。";
  if (observation.aiCalls7d === 0) return "F-035以降の直近7日AI callはまだありません。";
  if (observation.aiUsageComplete) return "このブログの価格・token usage coverageは完全です。";
  const coverage = observation.aiPriceCoveragePercent === null ? "usageなし" : `${observation.aiPriceCoveragePercent.toFixed(1)}%`;
  return `参考推定 · token価格coverage ${coverage}。欠損分を0円とは扱いません。`;
}

function searchWindowLabel(observation: BlogAiEfficiencyObservation) {
  if (!observation.searchWindowEnd) return "確定Search Console窓はまだありません";
  return `${observation.searchWindowStart}〜${observation.searchWindowEnd}`;
}

function liveBudgetDetail(scope: PerBlogBudgetHomeScope): string {
  const source = scope.limitSource === "override" ? "個別override" : "共通上限";
  if (scope.state === "exhausted") {
    return `${scope.scopeLabel} がブログ別AI日次call上限に到達: ${scope.calls}/${scope.limit} calls (${source}), day=${scope.dayKey} (${scope.timezone})。このブログの次のAI outbound callは上限が解消するまで送信されません。`;
  }
  return `${scope.scopeLabel} のブログ別AI日次call上限が80%以上: ${scope.utilizationPercent.toFixed(1)}%, ${scope.calls}/${scope.limit} calls (${source}), day=${scope.dayKey} (${scope.timezone})。まだ保護停止ではありません。`;
}

export default function Home() {
  const blogs = dashboard();
  const efficiency = aiEfficiencyPanel(blogs);
  const fallbackReviews = fallbackReviewQueue(12);
  const fallbackPublishQueue = fallbackApprovedPublishQueue(12);
  const fallbackQuality = fallbackQualitySummaries();
  const globalBudget = globalAiBudgetProtection();
  const globalBudgetWarning = globalAiBudgetWarning();
  const livePerBlogBudget = perBlogBudgetHomeSnapshot();
  const liveBudgetScopes = new Map(livePerBlogBudget.scopes.map((scope) => [scope.scopeKey, scope]));
  const budgetIncidents = new Map(openOperationalIncidentsByCode("ai-per-blog-budget-exhausted").map((incident) => [incident.scope, incident]));
  const budgetWarnings = new Map(openOperationalIncidentsByCode("ai-per-blog-budget-near-limit").map((incident) => [incident.scope, incident]));
  const active = blogs.filter((b) => b.active).length;
  const views = blogs.reduce((n, b) => n + b.views7d, 0);
  const errors = blogs.reduce((n, b) => n + b.failedRuns, 0);
  const attribution = efficiency.attributionCallCoveragePercent === null ? "帰属データ蓄積中" : `AI call帰属 ${efficiency.attributionCallCoveragePercent.toFixed(0)}%`;

  return (
    <main className="shell">
      <header className="hero">
        <div><p className="eyebrow">AUTONOMOUS EDITORIAL GARDEN</p><h1>Blog Garden</h1><p className="lead">複数のAI編集部が、それぞれの土で育つ。今日は庭全体だけ見ればいい。</p></div>
        <div className="actions"><RunButton /><Link className="button secondary" href="/diagnostics">健康診断</Link><Link className="button secondary" href="/setup">ブログを植える</Link></div>
      </header>

      {globalBudget ? (
        <section className="blogCard" aria-label="庭全体のAI予算保護状態" aria-live="polite">
          <div className="cardTop"><div><span className="dot" />庭全体のAI生成を保護停止</div><span className="platform">{globalBudget.reasonLabel}</span></div>
          <h3>global AI日次予算のhard capに到達しています</h3>
          <p className="muted">記事生成とAIを使う既存記事改善は保護停止中です。GA4・Search Console・コメントなどAIを使わない反応収集は継続します。</p>
          <div className="miniStats four">
            <div><span>AI calls</span><strong>{globalBudget.calls.toLocaleString()} / {globalBudget.callLimit.toLocaleString()}</strong></div>
            <div><span>AI tokens</span><strong>{globalBudget.totalTokens.toLocaleString()} / {globalBudget.tokenLimit.toLocaleString()}</strong></div>
            <div><span>budget day</span><strong>{globalBudget.dayKey}</strong></div>
            <div><span>timezone</span><strong>{globalBudget.timezone}</strong></div>
          </div>
          <div className="latest"><span>現在の保護状態</span><p>{globalBudget.reasonLabel}に到達したため、F-043と同じ現在値判定で庭全体の次のAI工程を止めています。</p><small>ブログのactive状態や公開方針は変更していません。hard capが解消すると次の実行からAI工程へ進めます。</small><div className="actions"><Link className="button secondary" href="/diagnostics">AI予算を健康診断で確認</Link></div></div>
        </section>
      ) : null}

      {globalBudgetWarning ? (
        <section className="blogCard" aria-label="庭全体のAI予算残量warning" aria-live="polite">
          <div className="cardTop"><div><span className="dot on" />AI予算の残りが少なくなっています</div><span className="platform">{globalBudgetWarning.reasonLabel}</span></div>
          <h3>global AI日次予算が {globalBudgetWarning.utilizationPercent}% に達しています</h3>
          <p className="muted">まだhard capには到達していないため、ブログは停止していません。停止前に使用量や上限設定を確認できます。</p>
          <div className="miniStats four">
            <div><span>AI calls</span><strong>{globalBudgetWarning.calls.toLocaleString()} / {globalBudgetWarning.callLimit.toLocaleString()}</strong></div>
            <div><span>AI tokens</span><strong>{globalBudgetWarning.totalTokens.toLocaleString()} / {globalBudgetWarning.tokenLimit.toLocaleString()}</strong></div>
            <div><span>budget day</span><strong>{globalBudgetWarning.dayKey}</strong></div>
            <div><span>timezone</span><strong>{globalBudgetWarning.timezone}</strong></div>
          </div>
          <div className="latest"><span>事前warning</span><p>F-046と同じ80%基準です。100%へ達するとF-045の「庭全体のAI生成を保護停止」表示へ切り替わります。</p><small>このwarning自体はAI処理・active状態・公開方針・routeを変更しません。</small><div className="actions"><Link className="button secondary" href="/diagnostics">AI予算を健康診断で確認</Link></div></div>
        </section>
      ) : null}

      <section className="stats" aria-label="全体状況">
        <article className="stat"><span>稼働ブログ</span><strong>{active}</strong></article>
        <article className="stat"><span>7日間 PV</span><strong>{views.toLocaleString()}</strong></article>
        <article className="stat"><span>7日間エラー</span><strong>{errors}</strong></article>
        <article className="stat"><span>AI保護停止</span><strong>{globalBudget ? "全体" : livePerBlogBudget.configError ? budgetIncidents.size : livePerBlogBudget.scopes.filter((scope) => scope.state === "exhausted").length}</strong></article>
      </section>

      {fallbackReviews.length > 0 ? <><section className="sectionHead"><div><p className="eyebrow">REVIEW QUEUE</p><h2>fallback生成 · 要レビュー</h2></div><span>{fallbackReviews.length} waiting</span></section><section className="grid" aria-label="fallback生成レビュー待ち">{fallbackReviews.map((item) => <article className="blogCard" key={item.publicationId}><div className="cardTop"><div><span className="dot" />要レビュー</div><span className="platform">{item.platform}</span></div><h3>{item.title}</h3><p className="muted">{item.blogName}</p><div className="latest"><span>生成経路</span><p>{item.providerLabel} / {item.model}</p><small>{item.bypassedPrimary ? "primary circuitを迂回してfallback生成" : "primary失敗後にfallback生成"} · {date(item.createdAt)}</small></div><div className="cardFoot"><span>下書きを確認して品質を記録</span><div className="actions">{item.url ? <a className="button secondary" href={item.url} target="_blank" rel="noreferrer">下書きを確認</a> : null}<FallbackReviewButton publicationId={item.publicationId} /></div></div></article>)}</section></> : null}

      {fallbackPublishQueue.length > 0 ? <><section className="sectionHead"><div><p className="eyebrow">APPROVED DRAFTS</p><h2>品質OK · 公開待ち</h2></div><span>{fallbackPublishQueue.length} ready</span></section><section className="grid" aria-label="品質OK fallback draft公開待ち">{fallbackPublishQueue.map((item) => <article className="blogCard" key={item.publicationId}><div className="cardTop"><div><span className="dot on" />品質OK</div><span className="platform">{item.platform}</span></div><h3>{item.title}</h3><p className="muted">{item.blogName}</p><div className="latest"><span>承認済み生成経路</span><p>{item.providerLabel} / {item.model}</p><small>{date(item.reviewedAt)} に人間が品質OK · 公開操作はまだ未実行</small></div><div className="cardFoot"><span>「公開する」を押した時だけ外部ブログを公開</span><div className="actions">{item.url ? <a className="button secondary" href={item.url} target="_blank" rel="noreferrer">下書きを再確認</a> : null}<FallbackPublishButton publicationId={item.publicationId} /></div></div></article>)}</section></> : null}

      {fallbackQuality.length > 0 ? <><section className="sectionHead"><div><p className="eyebrow">HUMAN QUALITY SIGNAL</p><h2>fallback品質実績</h2></div><span>人間レビューのみ</span></section><section className="grid" aria-label="fallback provider別品質実績">{fallbackQuality.map((item) => <article className="blogCard" key={`${item.providerLabel}:${item.model}`}><div className="cardTop"><div>{qualitySignal(item.signal)}</div><span className="platform">fallback</span></div><h3>{item.providerLabel}</h3><p className="muted">{item.model}</p><div className="miniStats four"><div><span>reviews</span><strong>{item.reviewed}</strong></div><div><span>品質OK</span><strong>{item.qualityOk}</strong></div><div><span>要改善</span><strong>{item.needsImprovement}</strong></div><div><span>OK率</span><strong>{item.approvalRate === null ? "—" : `${Math.round(item.approvalRate * 100)}%`}</strong></div></div><div className="latest"><span>運用判断</span><p>{item.reviewed < 10 ? "10件まではサンプル不足として扱います。" : `${qualitySignal(item.signal)}。実績を見て人間がallow-auto可否を判断します。`}</p><small>評価が高くてもBlog Gardenが自動でAI_FALLBACK_CONTENT_POLICYを変更することはありません。</small></div></article>)}</section></> : null}

      {blogs.length > 0 ? <><section className="sectionHead"><div><p className="eyebrow">COST × OUTCOME OBSERVATION</p><h2>AI費用と最近の反応</h2></div><span>{attribution} · ROIではありません</span></section><section className="grid" aria-label="ブログ別AI費用と成果の参考観測">{efficiency.observations.map((observation) => <article className="blogCard" key={`efficiency:${observation.blogId}`}><div className="cardTop"><div>{observation.flags.length ? `${observation.flags.length}件 確認` : "参考観測"}</div><span className="platform">7 days</span></div><h3>{observation.blogName}</h3><p className="muted">AI費用と反応を同じ場所で確認します。自動ROI判定やランキングは行いません。</p><div className="miniStats four"><div><span>AI推定 7d</span><strong>{aiCostLabel(observation, efficiency)}</strong></div><div><span>AI calls</span><strong>{observation.aiCalls7d}</strong></div><div><span>新規記事 7d</span><strong>{observation.publications7d}</strong></div><div><span>PV 7d</span><strong>{observation.views7d.toLocaleString()}</strong></div></div>{observation.flags.length ? <div className="latest"><span>確認するとよい運用シグナル</span>{observation.flags.map((flag) => <p key={flag.code}>{flag.tone === "warn" ? "要確認" : "参考"} · {flag.title} — {flag.detail}</p>)}<small>フラグは事実の確認入口です。低評価・ROI判定・自動停止・route変更には使いません。</small></div> : <div className="latest"><span>運用シグナル</span><p>現在の保守的ルールでは追加確認フラグはありません。</p><small>「問題なし」を保証するものではなく、機械的に断定できる観測事項がないという意味です。</small></div>}<div className="latest"><span>AI費用の観測品質</span><p>{aiCoverageLabel(observation, efficiency)}</p><small>F-035導入前などの帰属不能usageはブログへ推測配分しません。</small></div><div className="latest"><span>Search Console · 確定7日窓</span>{observation.searchWindowEnd ? <><p>{observation.searchImpressions.toLocaleString()} impressions · {observation.searchClicks.toLocaleString()} clicks · CTR {observation.searchCtrPercent === null ? "—" : `${observation.searchCtrPercent}%`} · 平均 {observation.searchPosition ?? "—"}位</p><small>{searchWindowLabel(observation)}。同じsnapshot_dateだけを合算し、異なる検索窓を混ぜません。</small></> : <p>確定Search Consoleデータはまだありません。</p>}</div><div className="latest"><span>補助シグナル</span><p>sessions 7d {observation.sessions7d.toLocaleString()} · engaged {observation.engagementRate === null ? "—" : `${observation.engagementRate}%`} · comments {observation.nativeComments} · run errors {observation.failedRuns7d}</p><small>AI費用は現在までの直近7日、Search Consoleは3日遅れの確定7日窓です。期間も因果も一致しないため「費用対効果」「1クリック単価」として解釈しません。</small></div></article>)}</section></> : null}

      <section className="sectionHead"><div><p className="eyebrow">YOUR GARDEN</p><h2>育っているブログ</h2></div><span>{blogs.length} plots</span></section>
      {blogs.length === 0 ? <section className="empty"><h3>最初の土はまだ空です。</h3><p>ブログを1つ登録すると、情報収集から育成ループが始まります。</p><Link className="button" href="/setup">最初のブログを設定</Link></section> : <section className="grid">{blogs.map((blog) => {
        const experiment = latestExperiment(blog.id);
        const refresh = latestContentRefresh(blog.id);
        const scopeKey = `blog:${blog.id}`;
        const persistentBudgetIncident = budgetIncidents.get(scopeKey);
        const persistentBudgetWarning = budgetWarnings.get(scopeKey);
        const liveBudgetScope = liveBudgetScopes.get(scopeKey);
        const currentBudgetState = livePerBlogBudget.configError ? persistentBudgetIncident ? "exhausted" : persistentBudgetWarning ? "near-limit" : null : liveBudgetScope?.state ?? null;
        const budgetIncident = currentBudgetState === "exhausted" ? persistentBudgetIncident : undefined;
        const budgetWarning = currentBudgetState === "near-limit" ? persistentBudgetWarning : undefined;
        const currentBudgetDetail = liveBudgetScope ? liveBudgetDetail(liveBudgetScope) : null;
        const aiProtected = Boolean(globalBudget || currentBudgetState === "exhausted");
        const aiStateLabel = currentBudgetState === "exhausted" ? "AI上限で保護停止" : globalBudget ? "庭全体AI上限で保護停止" : blog.active ? "自動運転" : "停止中";
        return <article className="blogCard" key={blog.id}>
          <div className="cardTop"><div><span className={`dot ${blog.active && !aiProtected ? "on" : ""}`} />{aiStateLabel}</div><span className="platform">{blog.platform}</span></div>
          <h3>{blog.name}</h3><p className="muted">{blog.niche}</p>
          {currentBudgetState === "exhausted" ? <div className="latest"><span>AI日次call上限 · 要確認</span><p>{budgetIncident?.detail || currentBudgetDetail || "現在のlive budget snapshotでブログ別AI日次call上限への到達を確認しました。"}</p><small>{budgetIncident ? `incident更新 ${date(budgetIncident.updatedAt)} · ` : liveBudgetScope ? `live判定 ${liveBudgetScope.calls}/${liveBudgetScope.limit} calls · ${liveBudgetScope.dayKey} (${liveBudgetScope.timezone}) · ` : ""}ブログ自体を停止したわけではありません。上限が解消すると次のAI工程から再開できます。</small><div className="actions"><Link className="button secondary" href={`/blogs/${blog.id}/settings`}>上限設定を確認</Link><Link className="button secondary" href="/diagnostics">健康診断で確認</Link></div></div> : null}
          {currentBudgetState === "near-limit" && !globalBudget ? <div className="latest"><span>AI日次call上限が近い · 事前warning</span><p>{budgetWarning?.detail || currentBudgetDetail || "現在のlive budget snapshotでブログ別AI日次call上限が80%以上です。"}</p><small>{budgetWarning ? `incident更新 ${date(budgetWarning.updatedAt)} · ` : liveBudgetScope ? `live判定 ${liveBudgetScope.utilizationPercent.toFixed(1)}% · ${liveBudgetScope.dayKey} (${liveBudgetScope.timezone}) · ` : ""}まだ保護停止ではないため自動運転は継続中です。100%に達すると保護停止表示へ切り替わります。</small><div className="actions"><Link className="button secondary" href={`/blogs/${blog.id}/settings`}>上限設定を確認</Link><Link className="button secondary" href="/diagnostics">健康診断で確認</Link></div></div> : null}
          <div className="miniStats four"><div><span>7d PV</span><strong>{blog.views7d.toLocaleString()}</strong></div><div><span>前週比</span><strong>{momentum(blog.momentumPercent)}</strong></div><div><span>engaged</span><strong>{blog.engagementRate === null ? "—" : `${blog.engagementRate}%`}</strong></div><div><span>comments</span><strong>{blog.nativeComments}</strong></div></div>
          <div className="latest"><span>検索シグナル</span>{blog.searchConsoleSiteUrl ? <><p>{blog.searchImpressions.toLocaleString()} impressions · {blog.searchClicks.toLocaleString()} clicks · CTR {blog.searchCtrPercent === null ? "—" : `${blog.searchCtrPercent}%`} · 平均 {blog.searchPosition ?? "—"}位</p><small>{blog.searchWindowEnd ? `確定窓 ${blog.searchWindowEnd} 終了 · ` : ""}{blog.topSearchQuery ? `強い検索語: ${blog.topSearchQuery}` : "Search Consoleの学習データを蓄積中"}</small></> : <p>Search Console未設定</p>}</div>
          <div className="latest"><span>学習中の実験</span><p>{experiment || "最初の記事から実験記憶を開始します"}</p></div>
          {refresh ? <div className="latest"><span>最近の自動改善 · {refreshResult(refresh.outcome)}</span><p>{refresh.beforeTitle} → {refresh.afterTitle}</p>{refresh.evaluation ? <small>CTR {(refresh.evaluation.beforeCtr * 100).toFixed(1)}% → {(refresh.evaluation.afterCtr * 100).toFixed(1)}% · 平均順位 {refresh.evaluation.beforePosition.toFixed(1)} → {refresh.evaluation.afterPosition.toFixed(1)} · {refresh.evaluation.reason}</small> : <small>{date(refresh.createdAt)} · 仮説: {refresh.hypothesis} · 14日後から評価</small>}</div> : null}
          <div className="latest"><span>最新</span>{blog.latestUrl ? <a href={blog.latestUrl} target="_blank" rel="noreferrer">{blog.latestTitle}</a> : <p>まだ公開記事はありません</p>}<small>{date(blog.latestPublishedAt)}</small></div>
          <div className="cardFoot"><span>{blog.publishMode === "auto" ? "自動公開" : "下書き確認"} · {blog.cadenceHours}h · 7d {blog.recentRuns} runs · {blog.failedRuns} errors</span><div className="actions"><Link className="button secondary" href={`/blogs/${blog.id}/settings`}>設定</Link><BlogToggleButton blogId={blog.id} active={blog.active} /><RunButton blogId={blog.id} /></div></div>
        </article>;
      })}</section>}
    </main>
  );
}
