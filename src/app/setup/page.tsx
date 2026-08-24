import Link from "next/link";

export default function SetupPage() {
  return (
    <main className="shell narrow">
      <Link href="/" className="back">← 庭へ戻る</Link>
      <header className="pageHead"><p className="eyebrow">PLANT A BLOG</p><h1>ブログを植える</h1><p className="lead">ここを一度設定すれば、以後はそのブログ専用のAI編集部として動きます。</p></header>
      <form className="setupForm" action="/api/blogs" method="post">
        <label>ブログ名<input name="name" required placeholder="例: 暮らしの小さな研究所" /></label>
        <label>テーマ / 誰に何を届けるか<textarea name="niche" required placeholder="例: 忙しい人向けに、生活を軽くするAI活用を実体験ベースで紹介" /></label>
        <div className="two"><label>媒体<select name="platform" defaultValue="wordpress"><option value="wordpress">WordPress</option><option value="ghost">Ghost</option><option value="blogger">Blogger</option></select></label><label>ブログURL<input name="siteUrl" type="url" required placeholder="https://example.com" /></label></div>
        <label>追うキーワード<input name="keywords" required placeholder="AI活用, 家事効率化, 時短" /><small>カンマ区切り。Google Newsの探索軸になります。</small></label>
        <label>追加RSS<input name="feeds" placeholder="https://example.com/feed, https://..." /><small>任意。信頼する専門媒体や公式ブログを追加できます。</small></label>
        <div className="two"><label>投稿間隔（時間）<input name="cadenceHours" type="number" min="1" defaultValue="24" /></label><label>1日最大本数<input name="dailyLimit" type="number" min="1" max="10" defaultValue="1" /></label></div>
        <label>公開方針<select name="publishMode" defaultValue="review"><option value="review">まず下書きへ送る</option><option value="auto">自動公開する</option></select></label>
        <label>媒体の資格情報 JSON<textarea className="code" name="credentialsJson" required placeholder={'WordPress: {"username":"...","applicationPassword":"..."}\nGhost: {"adminApiKey":"id:secret"}\nBlogger: {"blogId":"...","clientId":"...","clientSecret":"...","refreshToken":"..."}'} /><small>保存時にAES-256-GCMで暗号化されます。AIには渡しません。</small></label>
        <label>GA4 Property ID<input name="ga4PropertyId" placeholder="123456789" /><small>任意。設定すると実PVを次の記事判断へ戻します。</small></label>
        <button className="button large" type="submit">このブログを植える</button>
      </form>
    </main>
  );
}
