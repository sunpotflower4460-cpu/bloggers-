import Link from "next/link";
import { dashboard, experimentContext } from "@/lib/db";
import { fallbackReviewQueue } from "@/lib/fallback-review";
import { latestContentRefresh } from "@/lib/refresh-store";
import { BlogToggleButton } from "@/components/blog-toggle-button";
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

export default function Home() {
  const blogs = dashboard();
  const fallbackReviews = fallbackReviewQueue(12);
  const active = blogs.filter((b) => b.active).length;
  const views = blogs.reduce((n, b) => n + b.views7d, 0);
  const errors = blogs.reduce((n, b) => n + b.failedRuns, 0);
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">AUTONOMOUS EDITORIAL GARDEN</p>
          <h1>Blog Garden</h1>
          <p className="lead">複数のAI編集部が、それぞれの土で育つ。今日は庭全体だけ見ればいい。</p>
        </div>
        <div className="actions"><RunButton /><Link className="button secondary" href="/diagnostics">健康診断</Link><Link className="button secondary" href="/setup">ブログを植える</Link></div>
      </header>

      <section className="stats" aria-label="全体状況">
        <article className="stat"><span>稼働ブログ</span><strong>{active}</strong></article>
        <article className="stat"><span>7日間 PV</span><strong>{views.toLocaleString()}</strong></article>
        <article className="stat"><span>7日間エラー</span><strong>{errors}</strong></article>
      </section>

      {fallbackReviews.length > 0 ? (
        <>
          <section className="sectionHead"><div><p className="eyebrow">REVIEW QUEUE</p><h2>fallback生成 · 要レビュー</h2></div><span>{fallbackReviews.length} waiting</span></section>
          <section className="grid" aria-label="fallback生成レビュー待ち">
            {fallbackReviews.map((item) => (
              <article className="blogCard" key={item.publicationId}>
                <div className="cardTop"><div><span className="dot" />要レビュー</div><span className="platform">{item.platform}</span></div>
                <h3>{item.title}</h3>
                <p className="muted">{item.blogName}</p>
                <div className="latest">
                  <span>生成経路</span>
                  <p>{item.providerLabel} / {item.model}</p>
                  <small>{item.bypassedPrimary ? "primary circuitを迂回してfallback生成" : "primary失敗後にfallback生成"} · {date(item.createdAt)}</small>
                </div>
                <div className="cardFoot">
                  <span>自動公開せずdraftへ安全降格</span>
                  <div className="actions">
                    {item.url ? <a className="button" href={item.url} target="_blank" rel="noreferrer">下書きを確認</a> : null}
                    <FallbackReviewButton publicationId={item.publicationId} />
                  </div>
                </div>
              </article>
            ))}
          </section>
        </>
      ) : null}

      <section className="sectionHead"><div><p className="eyebrow">YOUR GARDEN</p><h2>育っているブログ</h2></div><span>{blogs.length} plots</span></section>
      {blogs.length === 0 ? (
        <section className="empty"><h3>最初の土はまだ空です。</h3><p>ブログを1つ登録すると、情報収集から育成ループが始まります。</p><Link className="button" href="/setup">最初のブログを設定</Link></section>
      ) : (
        <section className="grid">
          {blogs.map((blog) => {
            const experiment = latestExperiment(blog.id);
            const refresh = latestContentRefresh(blog.id);
            return (
              <article className="blogCard" key={blog.id}>
                <div className="cardTop"><div><span className={`dot ${blog.active ? "on" : ""}`} />{blog.active ? "自動運転" : "停止中"}</div><span className="platform">{blog.platform}</span></div>
                <h3>{blog.name}</h3><p className="muted">{blog.niche}</p>
                <div className="miniStats four">
                  <div><span>7d PV</span><strong>{blog.views7d.toLocaleString()}</strong></div>
                  <div><span>前週比</span><strong>{momentum(blog.momentumPercent)}</strong></div>
                  <div><span>engaged</span><strong>{blog.engagementRate === null ? "—" : `${blog.engagementRate}%`}</strong></div>
                  <div><span>comments</span><strong>{blog.nativeComments}</strong></div>
                </div>
                <div className="latest">
                  <span>検索シグナル</span>
                  {blog.searchConsoleSiteUrl ? (
                    <><p>{blog.searchImpressions.toLocaleString()} impressions · {blog.searchClicks.toLocaleString()} clicks · CTR {blog.searchCtrPercent === null ? "—" : `${blog.searchCtrPercent}%`} · 平均 {blog.searchPosition ?? "—"}位</p><small>{blog.topSearchQuery ? `強い検索語: ${blog.topSearchQuery}` : "Search Consoleの学習データを蓄積中"}</small></>
                  ) : <p>Search Console未設定</p>}
                </div>
                <div className="latest"><span>学習中の実験</span><p>{experiment || "最初の記事から実験記憶を開始します"}</p></div>
                {refresh ? (
                  <div className="latest">
                    <span>最近の自動改善 · {refreshResult(refresh.outcome)}</span>
                    <p>{refresh.beforeTitle} → {refresh.afterTitle}</p>
                    {refresh.evaluation ? (
                      <small>CTR {(refresh.evaluation.beforeCtr * 100).toFixed(1)}% → {(refresh.evaluation.afterCtr * 100).toFixed(1)}% · 平均順位 {refresh.evaluation.beforePosition.toFixed(1)} → {refresh.evaluation.afterPosition.toFixed(1)} · {refresh.evaluation.reason}</small>
                    ) : (
                      <small>{date(refresh.createdAt)} · 仮説: {refresh.hypothesis} · 14日後から評価</small>
                    )}
                  </div>
                ) : null}
                <div className="latest"><span>最新</span>{blog.latestUrl ? <a href={blog.latestUrl} target="_blank" rel="noreferrer">{blog.latestTitle}</a> : <p>まだ公開記事はありません</p>}<small>{date(blog.latestPublishedAt)}</small></div>
                <div className="cardFoot">
                  <span>{blog.publishMode === "auto" ? "自動公開" : "下書き確認"} · {blog.cadenceHours}h · 7d {blog.recentRuns} runs · {blog.failedRuns} errors</span>
                  <div className="actions">
                    <Link className="button secondary" href={`/blogs/${blog.id}/settings`}>設定</Link>
                    <BlogToggleButton blogId={blog.id} active={blog.active} />
                    <RunButton blogId={blog.id} />
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
