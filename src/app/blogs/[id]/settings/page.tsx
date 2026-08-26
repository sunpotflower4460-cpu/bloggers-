import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogSettingsForm } from "@/components/blog-settings-form";
import { blogAiDailyCallLimitOverride } from "@/lib/ai-budget-overrides";
import { getBlog } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function BlogSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const blog = getBlog(id);
  if (!blog) notFound();
  const { credentialsCipher, ...safeBlog } = blog;
  const aiDailyCallLimitOverride = blogAiDailyCallLimitOverride(blog.id);

  return (
    <main className="shell narrow">
      <Link href="/" className="back">← 庭へ戻る</Link>
      <header className="pageHead">
        <p className="eyebrow">TEND THIS PLOT</p>
        <h1>{blog.name}</h1>
        <p className="lead">育ち方を調整します。保存済みの秘密情報は表示せず、資格情報を入れ直した時だけ暗号化して置き換えます。</p>
      </header>
      <BlogSettingsForm blog={safeBlog} aiDailyCallLimitOverride={aiDailyCallLimitOverride} />
    </main>
  );
}
