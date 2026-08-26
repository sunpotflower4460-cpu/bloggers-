import Link from "next/link";
import { BlogSetupForm } from "@/components/blog-setup-form";

export default function SetupPage() {
  return (
    <main className="shell narrow">
      <Link href="/" className="back">← 庭へ戻る</Link>
      <header className="pageHead">
        <p className="eyebrow">PLANT A BLOG</p>
        <h1>ブログを植える</h1>
        <p className="lead">媒体を選ぶと必要な項目だけが出ます。接続確認までここで終えれば、以後はそのブログ専用のAI編集部として動きます。</p>
      </header>
      <BlogSetupForm />
    </main>
  );
}
