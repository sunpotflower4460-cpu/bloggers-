"use client";

import { useRef, useState } from "react";
import type { Blog, BlogPlatform } from "@/lib/types";

type SafeBlog = Omit<Blog, "credentialsCipher">;
type TestState = { kind: "idle" | "testing" | "ok" | "error"; message?: string };

function RotationFields({ platform }: { platform: BlogPlatform }) {
  if (platform === "wordpress") {
    return (
      <fieldset className="credentialBox">
        <legend>接続情報を変更する場合だけ入力</legend>
        <label>WordPressユーザー名<input name="wpUsername" autoComplete="username" /></label>
        <label>新しいApplication Password<input name="wpApplicationPassword" type="password" autoComplete="new-password" /><small>片方だけでは更新しません。変更する場合はユーザー名と新しいApplication Passwordを両方入力します。</small></label>
      </fieldset>
    );
  }
  if (platform === "ghost") {
    return (
      <fieldset className="credentialBox">
        <legend>接続情報を変更する場合だけ入力</legend>
        <label>新しいAdmin API Key<input name="ghostAdminApiKey" type="password" autoComplete="off" placeholder="id:secret" /></label>
      </fieldset>
    );
  }
  return (
    <fieldset className="credentialBox">
      <legend>接続情報を変更する場合だけ入力</legend>
      <label>Blog ID<input name="bloggerBlogId" /></label>
      <label>Google OAuth Client ID<input name="bloggerClientId" autoComplete="off" /></label>
      <label>Google OAuth Client Secret<input name="bloggerClientSecret" type="password" autoComplete="off" /></label>
      <label>Refresh Token<input name="bloggerRefreshToken" type="password" autoComplete="off" /><small>変更する場合は4項目すべて入力します。空欄なら保存済みの暗号化資格情報を維持します。</small></label>
    </fieldset>
  );
}

export function BlogSettingsForm({ blog }: { blog: SafeBlog }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  async function testConnection() {
    if (!formRef.current) return;
    setTest({ kind: "testing", message: "接続を確認しています…" });
    try {
      const response = await fetch(`/api/blogs/${encodeURIComponent(blog.id)}/test`, { method: "POST", body: new FormData(formRef.current) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "接続を確認できませんでした");
      setTest({ kind: "ok", message: payload.detail ? `${payload.label} — ${payload.detail}` : payload.label });
    } catch (error) {
      setTest({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <form ref={formRef} className="setupForm" action={`/api/blogs/${encodeURIComponent(blog.id)}`} method="post" onChange={() => test.kind !== "idle" && setTest({ kind: "idle" })}>
      <div className="formNotice"><strong>{blog.platform}</strong><span>媒体そのものは変更しません。別媒体へ移す場合は新しいブログとして登録します。</span></div>
      <label>ブログ名<input name="name" required defaultValue={blog.name} /></label>
      <label>テーマ / 誰に何を届けるか<textarea name="niche" required defaultValue={blog.niche} /></label>
      <label>{blog.platform === "ghost" ? "Ghost Admin URL" : "ブログURL"}<input name="siteUrl" type="url" required defaultValue={blog.siteUrl} /></label>
      <label>追うキーワード<input name="keywords" required defaultValue={blog.keywords.join(", ")} /><small>カンマ区切り。テーマを変えすぎず、探索軸だけ調整できます。</small></label>
      <label>追加RSS<input name="feeds" defaultValue={blog.feeds.join(", ")} /></label>
      <div className="two"><label>投稿間隔（時間）<input name="cadenceHours" type="number" min="1" defaultValue={blog.cadenceHours} /></label><label>1日最大本数<input name="dailyLimit" type="number" min="1" max="10" defaultValue={blog.dailyLimit} /></label></div>
      <label>公開方針<select name="publishMode" defaultValue={blog.publishMode}><option value="review">まず下書きへ送る</option><option value="auto">自動公開する</option></select></label>
      <label>GA4 Property ID<input name="ga4PropertyId" inputMode="numeric" defaultValue={blog.ga4PropertyId || ""} /><small>空欄にするとGA4反応学習を無効にします。</small></label>
      <label>Search Console Property<input name="searchConsoleSiteUrl" defaultValue={blog.searchConsoleSiteUrl || ""} placeholder="https://example.com/ または sc-domain:example.com" /><small>空欄にすると検索反応学習を無効にします。service accountメールには対象propertyの閲覧権限が必要です。</small></label>

      <RotationFields platform={blog.platform} />

      <div className="connectionRow">
        <button className="button secondary" type="button" onClick={testConnection} disabled={test.kind === "testing"}>{test.kind === "testing" ? "確認中…" : "現在の接続をテスト"}</button>
        {test.message ? <p className={`connectionMessage ${test.kind}`}>{test.message}</p> : <p className="connectionMessage">資格情報欄が空なら、保存済みの暗号化情報で接続確認します。</p>}
      </div>
      <button className="button large" type="submit">設定を保存</button>
    </form>
  );
}
