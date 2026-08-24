import { secureGeneratedArticle } from "../../src/lib/article-safety";

const safe = secureGeneratedArticle({
  title: "<b>安全なタイトル</b>",
  excerpt: "<script>bad()</script> 読者向けの説明",
  html: `
    <script>alert('x')</script>
    <iframe src="https://evil.invalid"></iframe>
    <form action="https://evil.invalid"><input name="x"></form>
    <svg onload="alert(1)"><circle></circle></svg>
    <h2 onclick="alert(1)">見出し</h2>
    <p style="background:url(javascript:alert(1))">本文です。安全性テストのため十分な長さを持たせます。AI生成記事本文として公開可能な通常テキストだけが残ることを確認します。</p>
    <p><a href="javascript&#58;alert(1)" onclick="alert(1)">危険リンク</a></p>
    <p><a href="https://example.com/source?utm_source=test">安全リンク</a></p>
    <blockquote><strong>引用ではなく通常の強調テキスト</strong></blockquote>
  `,
  tags: ["AI", "<img src=x onerror=alert(1)>安全", "AI"],
  sourceUrls: ["https://example.com/source"],
});

const forbidden = ["<script", "<iframe", "<form", "<svg", "onclick=", "style=", "javascript:", "onerror="];
for (const marker of forbidden) {
  if (safe.html.toLowerCase().includes(marker)) throw new Error(`unsafe marker survived: ${marker}`);
}
if (!safe.html.includes("https://example.com/source?utm_source=test")) throw new Error("safe HTTPS link was removed");
if (!safe.html.includes('rel="noopener noreferrer"')) throw new Error("safe link rel was not enforced");
if (safe.title !== "安全なタイトル") throw new Error(`title was not normalized: ${safe.title}`);
if (safe.tags.length !== 2 || safe.tags[1] !== "安全") throw new Error(`tags were not normalized: ${JSON.stringify(safe.tags)}`);

let rejected = false;
try {
  secureGeneratedArticle({ title: "x", excerpt: "x", html: "<script>only bad</script>", tags: [], sourceUrls: [] });
} catch {
  rejected = true;
}
if (!rejected) throw new Error("empty-after-filter article should be rejected");

console.log("article safety smoke passed");
