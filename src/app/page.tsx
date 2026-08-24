import Link from "next/link";
import { dashboard } from "@/lib/db";
import { BlogToggleButton } from "@/components/blog-toggle-button";
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

export default function Home() {
  const blogs = dashboard();
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
        <div className="actions"><RunButton /><Link className="button secondary" href="/setup">ブログを植える</Link></div>
      </header>

      <section className="stats" aria-label="全体状況">
        <article className="stat"><span>稼働ブログ</span><strong>{active}</strong></article>
        <article className="stat"><span>7日間 PV</span><strong>{views.toLocaleString()}</strong></article>
        <article className="stat"><span>7日間エラー</span><strong>{errors}</strong></article>
      </section>

      <section className="sectionHead"><div><p className="eyebrow">YOUR GARDEN</p><h2>育っているブログ</h2></div><span>{blogs.length} plots</span></section>
      {blogs.length === 0 ? (
        <section className="empty"><h3>最初の土はまだ空です。</h3><p>ブログを1つ登録すると、情報収集から育成ループが始まります。</p><Link className="button" href="/setup">最初のブログを設定</Link></section>
      ) : (
        <section className="grid">
          {blogs.map((blog) => (
            <article className="blogCard" key={blog.id}>
              <div className="cardTop"><div><span className={`dot ${blog.active ? "on" : ""}`} />{blog.active ? "自動運転" : "停止中"}</div><span className="platform">{blog.platform}</span></div>
              <h3>{blog.name}</h3><p className="muted">{blog.niche}</p>
              <div className="miniStats four">
                <div><span>7d PV</span><strong>{blog.views7d.toLocaleString()}</strong></div>
                <div><span>前週比</span><strong>{momentum(blog.momentumPercent)}</strong></div>
                <div><span>engaged</span><strong>{blog.engagementRate === null ? "—" : `${blog.engagementRate}%`}</strong></div>
                <div><span>comments</span><strong>{blog.nativeComments}</strong></div>
              </div>
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
          ))}
        </section>
      )}
    </main>
  );
}
