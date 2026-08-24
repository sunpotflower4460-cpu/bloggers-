import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { testSearchConsole } from "./analytics/search-console";
import { decryptJson } from "./crypto";
import { listBlogs } from "./db";
import { platformAdapter } from "./platforms";

export type DiagnosticStatus = "ok" | "warn" | "error";

export interface DiagnosticItem {
  scope: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
}

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function backupDiagnostic(): DiagnosticItem {
  const backupDir = resolve(process.env.BACKUP_DIR || "./backups");
  if (!existsSync(backupDir)) {
    return { scope: "system", label: "自動バックアップ", status: "warn", detail: `バックアップディレクトリがまだ見つかりません: ${backupDir}` };
  }
  const files = readdirSync(backupDir)
    .filter((name) => /^blog-garden-\d{8}-\d{6}Z\.sqlite$/.test(name))
    .map((name) => ({ name, stat: statSync(join(backupDir, name)) }))
    .filter((entry) => entry.stat.isFile() && entry.stat.size > 0)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!files.length) {
    return { scope: "system", label: "自動バックアップ", status: "warn", detail: "検証済みバックアップがまだありません" };
  }
  const latest = files[0];
  const ageHours = (Date.now() - latest.stat.mtimeMs) / 3600000;
  const status: DiagnosticStatus = ageHours <= 36 ? "ok" : ageHours <= 72 ? "warn" : "error";
  return {
    scope: "system",
    label: "自動バックアップ",
    status,
    detail: `${latest.name} · ${Math.round(ageHours * 10) / 10}時間前 · ${(latest.stat.size / 1024 / 1024).toFixed(1)} MB`,
  };
}

export async function runDiagnostics(): Promise<DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];
  const encryptionKey = process.env.APP_ENCRYPTION_KEY || "";
  items.push({
    scope: "system",
    label: "暗号化キー",
    status: /^[a-f0-9]{64}$/i.test(encryptionKey) ? "ok" : "error",
    detail: /^[a-f0-9]{64}$/i.test(encryptionKey) ? "AES-256用の64桁hexを確認" : "APP_ENCRYPTION_KEY は64桁hexが必要です",
  });
  items.push({
    scope: "system",
    label: "AI設定",
    status: configured(process.env.AI_API_KEY) && configured(process.env.AI_MODEL) ? "ok" : "error",
    detail: configured(process.env.AI_API_KEY) && configured(process.env.AI_MODEL) ? `model=${process.env.AI_MODEL}` : "AI_API_KEY / AI_MODEL を設定してください",
  });
  if (process.env.NODE_ENV === "production") {
    items.push({
      scope: "system",
      label: "管理画面認証",
      status: configured(process.env.ADMIN_USERNAME) && configured(process.env.ADMIN_PASSWORD) ? "ok" : "error",
      detail: configured(process.env.ADMIN_USERNAME) && configured(process.env.ADMIN_PASSWORD) ? "Basic認証設定済み" : "productionではADMIN_USERNAME / ADMIN_PASSWORDが必須です",
    });
  }

  let blogs;
  try {
    blogs = listBlogs();
    items.push({ scope: "system", label: "SQLite", status: "ok", detail: `${blogs.length} blogs を読み取り` });
  } catch (error) {
    items.push({ scope: "system", label: "SQLite", status: "error", detail: error instanceof Error ? error.message : String(error) });
    return items;
  }

  try {
    items.push(backupDiagnostic());
  } catch (error) {
    items.push({ scope: "system", label: "自動バックアップ", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }

  const needsGoogle = blogs.some((blog) => blog.ga4PropertyId || blog.searchConsoleSiteUrl);
  if (needsGoogle) {
    items.push({
      scope: "system",
      label: "Google service account",
      status: configured(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ? "ok" : "error",
      detail: configured(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ? "GA4 / Search Console認証情報あり" : "Google連携を使うブログがありますがGOOGLE_SERVICE_ACCOUNT_JSONがありません",
    });
  }

  for (const blog of blogs) {
    try {
      const credentials = decryptJson<unknown>(blog.credentialsCipher);
      const result = await platformAdapter(blog.platform).validate(blog.siteUrl, credentials);
      items.push({ scope: blog.name, label: `${blog.platform} 投稿接続`, status: "ok", detail: result.detail || result.label });
    } catch (error) {
      items.push({ scope: blog.name, label: `${blog.platform} 投稿接続`, status: "error", detail: error instanceof Error ? error.message : String(error) });
    }

    if (blog.ga4PropertyId) {
      items.push({
        scope: blog.name,
        label: "GA4",
        status: configured(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ? "ok" : "error",
        detail: configured(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ? `property=${blog.ga4PropertyId}（実データ取得はworkerで確認）` : "service account未設定",
      });
    }

    if (blog.searchConsoleSiteUrl) {
      try {
        const result = await testSearchConsole(blog.searchConsoleSiteUrl);
        items.push({ scope: blog.name, label: "Search Console", status: "ok", detail: result.rows > 0 ? "propertyを読み取り、検索データあり" : "propertyを読み取り可能。対象期間のデータは0件" });
      } catch (error) {
        items.push({ scope: blog.name, label: "Search Console", status: "error", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return items;
}
