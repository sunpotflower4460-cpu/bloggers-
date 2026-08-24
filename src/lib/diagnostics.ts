import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { aiBudgetStatus } from "./ai-budget";
import { aiRoutingStatus } from "./ai-routing";
import { testSearchConsole } from "./analytics/search-console";
import { decryptJson } from "./crypto";
import { listBlogs } from "./db";
import { monitorStatus } from "./ops-monitor";
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

function backupDir(): string {
  return resolve(process.env.BACKUP_DIR || "./backups");
}

function backupDiagnostic(): DiagnosticItem {
  const dir = backupDir();
  if (!existsSync(dir)) {
    return { scope: "system", label: "自動バックアップ", status: "warn", detail: `バックアップディレクトリがまだ見つかりません: ${dir}` };
  }
  const files = readdirSync(dir)
    .filter((name) => /^blog-garden-\d{8}-\d{6}Z\.sqlite$/.test(name))
    .map((name) => ({ name, stat: statSync(join(dir, name)) }))
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

function offsiteBackupDiagnostic(): DiagnosticItem | null {
  if (!configured(process.env.RESTIC_REPOSITORY)) return null;
  const marker = join(backupDir(), ".offsite-last-success");
  if (!existsSync(marker)) {
    return { scope: "system", label: "オフサイトバックアップ", status: "warn", detail: "restic repository設定済み。成功markerはまだありません" };
  }
  const stat = statSync(marker);
  const ageHours = Math.max(0, (Date.now() - stat.mtimeMs) / 3600000);
  return {
    scope: "system",
    label: "オフサイトバックアップ",
    status: ageHours <= 36 ? "ok" : ageHours <= 72 ? "warn" : "error",
    detail: `restic最終成功 ${Math.round(ageHours * 10) / 10}時間前`,
  };
}

function monitorDiagnostic(): DiagnosticItem {
  const status = monitorStatus();
  if (!status.lastSeen) {
    return { scope: "system", label: "独立monitor", status: "warn", detail: `heartbeat未確認 · open incidents ${status.openIncidents}` };
  }
  const ageHours = Math.max(0, (Date.now() - new Date(status.lastSeen).getTime()) / 3600000);
  return {
    scope: "system",
    label: "独立monitor",
    status: ageHours <= 2 ? "ok" : ageHours <= 4 ? "warn" : "error",
    detail: `${Math.round(ageHours * 10) / 10}時間前に確認 · open incidents ${status.openIncidents}`,
  };
}

function aiBudgetDiagnostic(): DiagnosticItem {
  const budget = aiBudgetStatus();
  const status: DiagnosticStatus = budget.exhausted ? "error" : budget.utilization >= 0.8 ? "warn" : "ok";
  return {
    scope: "system",
    label: "AI日次予算",
    status,
    detail: `${budget.dayKey} (${budget.timezone}) · calls ${budget.calls}/${budget.callLimit} · tokens ${budget.totalTokens.toLocaleString()}/${budget.tokenLimit.toLocaleString()}`,
  };
}

function aiRoutingDiagnostic(): DiagnosticItem {
  const routing = aiRoutingStatus();
  if (!routing.configured) {
    return {
      scope: "system",
      label: "AI failover",
      status: "error",
      detail: routing.configError || "AI routing configuration is invalid",
    };
  }
  if (!routing.fallbackConfigured) {
    return {
      scope: "system",
      label: "AI failover",
      status: "warn",
      detail: `${routing.primaryLabel}/${routing.primaryModel} の単一路線 · 24h attempts ${routing.primaryAttempts24h} · fallback未設定`,
    };
  }
  const status: DiagnosticStatus = routing.primaryDegraded
    ? routing.fallbackCurrentlyHealthy ? "warn" : "error"
    : "ok";
  const lastFallback = routing.lastFallbackAt ? ` · last fallback ${routing.lastFallbackAt}` : "";
  const circuit = routing.circuitOpen
    ? ` · CIRCUIT OPEN → primaryを迂回中（${routing.circuitUntil}まで、最大${routing.circuitMinutes}分）`
    : ` · circuit closed（${routing.circuitMinutes}分）`;
  return {
    scope: "system",
    label: "AI failover",
    status,
    detail: `${routing.primaryLabel}/${routing.primaryModel} → ${routing.fallbackLabel}/${routing.fallbackModel} · primary retryable ${routing.primaryRetryableFailures24h}/${routing.primaryAttempts24h} · fallback success ${routing.fallbackSuccesses24h}/${routing.fallbackAttempts24h}${lastFallback}${circuit}`,
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
  try {
    items.push(aiBudgetDiagnostic());
  } catch (error) {
    items.push({ scope: "system", label: "AI日次予算", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    items.push(aiRoutingDiagnostic());
  } catch (error) {
    items.push({ scope: "system", label: "AI failover", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
  items.push({
    scope: "system",
    label: "障害通知Webhook",
    status: configured(process.env.ALERT_WEBHOOK_URL) ? "ok" : "warn",
    detail: configured(process.env.ALERT_WEBHOOK_URL) ? `設定済み (${process.env.ALERT_WEBHOOK_KIND || "auto"})` : "未設定。incidentはDBに残りますが外部通知は送られません",
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
    const offsite = offsiteBackupDiagnostic();
    if (offsite) items.push(offsite);
  } catch (error) {
    items.push({ scope: "system", label: "バックアップ", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    items.push(monitorDiagnostic());
  } catch (error) {
    items.push({ scope: "system", label: "独立monitor", status: "error", detail: error instanceof Error ? error.message : String(error) });
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
