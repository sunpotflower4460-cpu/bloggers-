"use client";

import { useRef, useState } from "react";
import type { BlogPlatform } from "@/lib/types";

type TestState = { kind: "idle" | "testing" | "ok" | "error"; message?: string };

function CredentialFields({ platform }: { platform: BlogPlatform }) {
  if (platform === "wordpress") {
    return (
      <fieldset className="credentialBox">
        <legend>WordPress 接続</legend>
        <label>WordPressユーザー名<input name="wpUsername" autoComplete="username" required /></label>
        <label>Application Password<input name="wpApplicationPassword" type="password" autoComplete="new-password" required /><small>WordPress管理画面 → ユーザー → プロフィール → Application Passwords でBlog Garden専用のものを作成してください。通常のログインパスワードは使いません。</small></label>
      </fieldset>
    );
  }

  if (platform === "ghost") {
    return (
      <fieldset className="credentialBox">
        <legend>Ghost 接続</legend>
        <label>Admin API Key<input name="ghostAdminApiKey" type="password" autoComplete="off" required placeholder="id:secret" /><small>Ghost Admin → Settings → Integrations → Custom Integration から取得できます。</small></label>
      </fieldset>
    );
  }

  return (
    <fieldset className="credentialBox">
      <legend>Blogger 接続</legend>
      <label>Blog ID<input name="bloggerBlogId" required /></label>
      <label>Google OAuth Client ID<input name="bloggerClientId" autoComplete="off" required /></label>
      <label>Google OAuth Client Secret<input name="bloggerClientSecret" type="password" autoComplete="off" required /></label>
      <label>Refresh Token<input name="bloggerRefreshToken" type="password" autoComplete="off" required /><small>投稿権限を持つGoogle OAuthのRefresh Tokenを保存します。Access Tokenは都度サーバー側で再発行します。</small></label>
    </fieldset>
  );
}

export function BlogSetupForm() {
  const [platform, setPlatform] = useState<BlogPlatform>("wordpress");
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const formRef = useRef<HTMLFormElement>(null);

  async function testConnection() {
    if (!formRef.current) return;
    if (!formRef.current.reportValidity()) return;
    setTest({ kind: "testing", message: "接続を確認しています…" });
    try {
      const response = await fetch("/api/platforms/test", { method: "POST", body: new FormData(formRef.current) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "接続を確認できませんでした");
      setTest({ kind: "ok", message: payload.detail ? `${payload.label} — ${payload.detail}` : payload.label });
    } catch (error) {
      setTest({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <form ref={formRef} className="setupForm" action="/api/blogs" method="post" onChange={() => test.kind !== "idle" && setTest({ kind: "idle" })}>
      <label>ブログ名<input name="name" required placeholder="例: 暮らしの小さな研究所" /></label>
      <label>テーマ / 誰に何を届けるか<textarea name="niche" required placeholder="例: 忙しい人向けに、生活を軽くするAI活用を実体験ベースで紹介" /></label>
      <div className="two">
        <label>媒体<select name="platform" value={platform} onChange={(event) => setPlatform(event.target.value as BlogPlatform)}><option value="wordpress">WordPress</option><option value="ghost">Ghost</option><option value="blogger">Blogger</option></select></label>
        <label>{platform === "ghost" ? "Ghost Admin URL" : "ブログURL"}<input name="siteUrl" type="url" required placeholder={platform === "ghost" ? "https://your-site.ghost.io" : "https://example.com"} /><small>{platform === "ghost" ? "公開URLとAdmin domainが違う場合はAdmin APIへ到達できるURLを入力します。" : "末尾の / はどちらでも構いません。"}</small></label>
      </div>
      <label>追うキーワード<input name="keywords" required placeholder="AI活用, 家事効率化, 時短" /><small>カンマ区切り。Google Newsの探索軸になります。</small></label>
      <label>追加RSS<input name="feeds" placeholder="https://example.com/feed, https://..." /><small>任意。信頼する専門媒体や公式ブログを追加できます。</small></label>
      <div className="two"><label>投稿間隔（時間）<input name="cadenceHours" type="number" min="1" defaultValue="24" /></label><label>1日最大本数<input name="dailyLimit" type="number" min="1" max="10" defaultValue="1" /></label></div>
      <label>公開方針<select name="publishMode" defaultValue="review"><option value="review">まず下書きへ送る</option><option value="auto">自動公開する</option></select><small>最初は「下書き確認」がおすすめです。内容を確認できたら後から自動公開へ変更できます。</small></label>

      <CredentialFields platform={platform} />

      <div className="connectionRow">
        <button className="button secondary" type="button" onClick={testConnection} disabled={test.kind === "testing"}>{test.kind === "testing" ? "確認中…" : "接続テスト"}</button>
        {test.message ? <p className={`connectionMessage ${test.kind}`}>{test.message}</p> : <p className="connectionMessage">保存前に実際の投稿権限まで確認できます。</p>}
      </div>

      <label>GA4 Property ID<input name="ga4PropertyId" inputMode="numeric" placeholder="123456789" /><small>任意。設定すると実PV・セッション・エンゲージメントを次の記事判断へ戻します。</small></label>
      <button className="button large" type="submit">このブログを植える</button>
    </form>
  );
}
