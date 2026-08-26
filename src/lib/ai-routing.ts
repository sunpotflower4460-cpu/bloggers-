import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AiRouteKind = "primary" | "fallback" | "economy";
export type AiAttemptOutcome = "ok" | "retryable_error" | "fatal_error";
export type AiInternalRoutePolicy = "primary" | "economy";

export interface AiRoute {
  kind: AiRouteKind;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiRoutePlan {
  primary: AiRoute | null;
  fallback: AiRoute | null;
  bypassedPrimary: boolean;
}

export interface AiInternalRoutePlan {
  policy: AiInternalRoutePolicy;
  preferred: AiRoute;
  recovery: AiRoute | null;
  bypassedPrimary: boolean;
}

export interface AiRoutingStatus {
  configured: boolean;
  configError: string | null;
  primaryLabel: string;
  primaryModel: string | null;
  fallbackConfigured: boolean;
  fallbackLabel: string | null;
  fallbackModel: string | null;
  internalPolicy: AiInternalRoutePolicy | "invalid";
  economyConfigured: boolean;
  economyLabel: string | null;
  economyModel: string | null;
  primaryAttempts24h: number;
  primaryRetryableFailures24h: number;
  primaryFatalFailures24h: number;
  fallbackAttempts24h: number;
  fallbackSuccesses24h: number;
  fallbackFailures24h: number;
  lastFallbackAt: string | null;
  economyAttempts24h: number;
  economySuccesses24h: number;
  economyFailures24h: number;
  lastEconomyAt: string | null;
  economyCurrentlyHealthy: boolean;
  primaryDegraded: boolean;
  fallbackCurrentlyHealthy: boolean;
  circuitOpen: boolean;
  circuitMinutes: number;
  circuitUntil: string | null;
}

type DB = InstanceType<typeof Database>;
const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenAiRoutingDb?: DB };
const db = globalDb.__blogGardenAiRoutingDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenAiRoutingDb = db;
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS ai_provider_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_at TEXT NOT NULL,
  route TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status_code INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_attempts_recent
  ON ai_provider_attempts(route, attempted_at DESC);
`);

function value(name: string): string | null {
  const item = process.env[name]?.trim();
  return item || null;
}

function required(name: string): string {
  const item = value(name);
  if (!item) throw new Error(`${name} is required`);
  return item;
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function circuitMinutes(): number {
  return positiveInt(value("AI_PRIMARY_CIRCUIT_MINUTES"), 30, 240);
}

function cleanLabel(raw: string | null, fallback: string): string {
  const text = (raw || fallback).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 80) || fallback;
}

function normalizeBase(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("AI base URL must not contain embedded credentials");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("AI base URL must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}

function sameOrigin(a: string, b: string): boolean {
  return new URL(a).origin === new URL(b).origin;
}

export function internalRoutePolicy(): AiInternalRoutePolicy {
  const raw = (value("AI_INTERNAL_ROUTE_POLICY") || "primary").toLowerCase();
  if (raw === "primary" || raw === "economy") return raw;
  throw new Error("AI_INTERNAL_ROUTE_POLICY must be 'primary' or 'economy'");
}

export function resolveAiRoutes(): AiRoute[] {
  const primaryBase = normalizeBase(value("AI_BASE_URL") || "https://api.openai.com/v1");
  const primaryModel = required("AI_MODEL");
  const primaryKey = required("AI_API_KEY");
  const primary: AiRoute = {
    kind: "primary",
    label: cleanLabel(value("AI_PRIMARY_PROVIDER_LABEL"), "primary"),
    baseUrl: primaryBase,
    model: primaryModel,
    apiKey: primaryKey,
  };

  const fallbackModel = value("AI_FALLBACK_MODEL");
  const fallbackBaseRaw = value("AI_FALLBACK_BASE_URL");
  const fallbackKeyRaw = value("AI_FALLBACK_API_KEY");
  if (!fallbackModel) {
    if (fallbackBaseRaw || fallbackKeyRaw) {
      throw new Error("AI_FALLBACK_MODEL is required when fallback base URL or API key is configured");
    }
    return [primary];
  }

  const fallbackBase = normalizeBase(fallbackBaseRaw || primaryBase);
  const crossHost = !sameOrigin(primaryBase, fallbackBase);
  let fallbackKey = fallbackKeyRaw;
  if (!fallbackKey) {
    if (crossHost) {
      throw new Error("AI_FALLBACK_API_KEY is required when fallback uses a different host");
    }
    fallbackKey = primaryKey;
  }
  if (crossHost && fallbackKey === primaryKey) {
    throw new Error("Cross-host AI fallback must use a credential different from AI_API_KEY");
  }

  const fallback: AiRoute = {
    kind: "fallback",
    label: cleanLabel(value("AI_FALLBACK_PROVIDER_LABEL"), "fallback"),
    baseUrl: fallbackBase,
    model: fallbackModel,
    apiKey: fallbackKey,
  };

  if (fallback.baseUrl === primary.baseUrl && fallback.model === primary.model && fallback.apiKey === primary.apiKey) {
    throw new Error("AI fallback route must differ from the primary route");
  }
  return [primary, fallback];
}

export function resolveEconomyRoute(primaryInput?: AiRoute): AiRoute | null {
  const policy = internalRoutePolicy();
  const economyModel = value("AI_ECONOMY_MODEL");
  const economyBaseRaw = value("AI_ECONOMY_BASE_URL");
  const economyKeyRaw = value("AI_ECONOMY_API_KEY");
  if (!economyModel) {
    if (economyBaseRaw || economyKeyRaw) {
      throw new Error("AI_ECONOMY_MODEL is required when economy base URL or API key is configured");
    }
    if (policy === "economy") throw new Error("AI_ECONOMY_MODEL is required when AI_INTERNAL_ROUTE_POLICY=economy");
    return null;
  }

  const primary = primaryInput ?? resolveAiRoutes()[0];
  const economyBase = normalizeBase(economyBaseRaw || primary.baseUrl);
  const crossHost = !sameOrigin(primary.baseUrl, economyBase);
  let economyKey = economyKeyRaw;
  if (!economyKey) {
    if (crossHost) throw new Error("AI_ECONOMY_API_KEY is required when economy uses a different host");
    economyKey = primary.apiKey;
  }
  if (crossHost && economyKey === primary.apiKey) {
    throw new Error("Cross-host AI economy route must use a credential different from AI_API_KEY");
  }

  const economy: AiRoute = {
    kind: "economy",
    label: cleanLabel(value("AI_ECONOMY_PROVIDER_LABEL"), "economy"),
    baseUrl: economyBase,
    model: economyModel,
    apiKey: economyKey,
  };
  if (economy.baseUrl === primary.baseUrl && economy.model === primary.model && economy.apiKey === primary.apiKey) {
    throw new Error("AI economy route must differ from the primary route");
  }
  return economy;
}

function safeDetail(value: unknown): string {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (candidate) => {
      try {
        const parsed = new URL(candidate);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function recordAiProviderAttempt(input: {
  route: AiRouteKind;
  label: string;
  model: string;
  outcome: AiAttemptOutcome;
  statusCode?: number | null;
  detail?: unknown;
}): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_provider_attempts
    (attempted_at,route,label,model,outcome,status_code,detail)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      now,
      input.route,
      cleanLabel(input.label, input.route),
      input.model.slice(0, 160),
      input.outcome,
      Number.isFinite(input.statusCode) ? input.statusCode : null,
      input.detail == null ? null : safeDetail(input.detail),
    );
  db.prepare("DELETE FROM ai_provider_attempts WHERE julianday(attempted_at) < julianday('now','-30 day')").run();
}

function count24h(route: AiRouteKind, outcome?: AiAttemptOutcome): number {
  const row = outcome
    ? db.prepare(`SELECT COUNT(*) n FROM ai_provider_attempts
        WHERE route=? AND outcome=? AND julianday(attempted_at)>=julianday('now','-24 hour')`).get(route, outcome)
    : db.prepare(`SELECT COUNT(*) n FROM ai_provider_attempts
        WHERE route=? AND julianday(attempted_at)>=julianday('now','-24 hour')`).get(route);
  return Number((row as { n: number } | undefined)?.n || 0);
}

function recentPrimaryAttempts(): Array<{ attempted_at: string; outcome: AiAttemptOutcome }> {
  return db.prepare(`SELECT attempted_at,outcome FROM ai_provider_attempts
    WHERE route='primary' ORDER BY id DESC LIMIT 3`).all() as Array<{ attempted_at: string; outcome: AiAttemptOutcome }>;
}

function isPrimaryDegraded(rows: Array<{ attempted_at: string; outcome: AiAttemptOutcome }>): boolean {
  return rows.length === 3
    && rows.every((row) => row.outcome === "retryable_error")
    && Date.now() - new Date(rows[2].attempted_at).getTime() <= 6 * 3600000;
}

function circuitState(rows: Array<{ attempted_at: string; outcome: AiAttemptOutcome }>, fallbackConfigured: boolean): {
  open: boolean;
  minutes: number;
  until: string | null;
} {
  const minutes = circuitMinutes();
  if (!fallbackConfigured || !isPrimaryDegraded(rows)) return { open: false, minutes, until: null };
  const latestAt = new Date(rows[0].attempted_at).getTime();
  const untilMs = latestAt + minutes * 60000;
  if (!Number.isFinite(latestAt) || Date.now() >= untilMs) return { open: false, minutes, until: null };
  return { open: true, minutes, until: new Date(untilMs).toISOString() };
}

function routingConfigSummary(): {
  configured: boolean;
  configError: string | null;
  primaryLabel: string;
  primaryModel: string | null;
  fallbackConfigured: boolean;
  fallbackLabel: string | null;
  fallbackModel: string | null;
  internalPolicy: AiInternalRoutePolicy | "invalid";
  economyConfigured: boolean;
  economyLabel: string | null;
  economyModel: string | null;
} {
  const primaryLabel = cleanLabel(value("AI_PRIMARY_PROVIDER_LABEL"), "primary");
  const primaryModel = value("AI_MODEL");
  const fallbackModel = value("AI_FALLBACK_MODEL");
  const fallbackLabel = fallbackModel ? cleanLabel(value("AI_FALLBACK_PROVIDER_LABEL"), "fallback") : null;
  const economyModel = value("AI_ECONOMY_MODEL");
  const economyLabel = economyModel ? cleanLabel(value("AI_ECONOMY_PROVIDER_LABEL"), "economy") : null;
  let policy: AiInternalRoutePolicy | "invalid" = "invalid";
  try {
    policy = internalRoutePolicy();
    const routes = resolveAiRoutes();
    resolveEconomyRoute(routes[0]);
    return {
      configured: true,
      configError: null,
      primaryLabel,
      primaryModel,
      fallbackConfigured: Boolean(fallbackModel),
      fallbackLabel,
      fallbackModel,
      internalPolicy: policy,
      economyConfigured: Boolean(economyModel),
      economyLabel,
      economyModel,
    };
  } catch (error) {
    return {
      configured: false,
      configError: safeDetail(error instanceof Error ? error.message : error),
      primaryLabel,
      primaryModel,
      fallbackConfigured: Boolean(fallbackModel),
      fallbackLabel,
      fallbackModel,
      internalPolicy: policy,
      economyConfigured: Boolean(economyModel),
      economyLabel,
      economyModel,
    };
  }
}

export function aiRoutingStatus(): AiRoutingStatus {
  const config = routingConfigSummary();
  const recentPrimary = recentPrimaryAttempts();
  const primaryDegraded = isPrimaryDegraded(recentPrimary);
  const circuit = circuitState(recentPrimary, config.fallbackConfigured);
  const latestFallback = db.prepare(`SELECT attempted_at,outcome FROM ai_provider_attempts
      WHERE route='fallback' ORDER BY id DESC LIMIT 1`).get() as { attempted_at: string; outcome: AiAttemptOutcome } | undefined;
  const latestEconomy = db.prepare(`SELECT attempted_at,outcome FROM ai_provider_attempts
      WHERE route='economy' ORDER BY id DESC LIMIT 1`).get() as { attempted_at: string; outcome: AiAttemptOutcome } | undefined;

  return {
    ...config,
    primaryAttempts24h: count24h("primary"),
    primaryRetryableFailures24h: count24h("primary", "retryable_error"),
    primaryFatalFailures24h: count24h("primary", "fatal_error"),
    fallbackAttempts24h: count24h("fallback"),
    fallbackSuccesses24h: count24h("fallback", "ok"),
    fallbackFailures24h: count24h("fallback", "retryable_error") + count24h("fallback", "fatal_error"),
    lastFallbackAt: latestFallback?.attempted_at ?? null,
    economyAttempts24h: count24h("economy"),
    economySuccesses24h: count24h("economy", "ok"),
    economyFailures24h: count24h("economy", "retryable_error") + count24h("economy", "fatal_error"),
    lastEconomyAt: latestEconomy?.attempted_at ?? null,
    economyCurrentlyHealthy: latestEconomy?.outcome === "ok",
    primaryDegraded,
    fallbackCurrentlyHealthy: latestFallback?.outcome === "ok",
    circuitOpen: circuit.open,
    circuitMinutes: circuit.minutes,
    circuitUntil: circuit.until,
  };
}

export function resolveAiRoutePlan(): AiRoutePlan {
  const routes = resolveAiRoutes();
  const primary = routes[0];
  const fallback = routes[1] ?? null;
  if (!fallback) return { primary, fallback: null, bypassedPrimary: false };
  const circuit = circuitState(recentPrimaryAttempts(), true);
  if (circuit.open) return { primary: null, fallback, bypassedPrimary: true };
  return { primary, fallback, bypassedPrimary: false };
}

export function resolveAiInternalRoutePlan(): AiInternalRoutePlan {
  const policy = internalRoutePolicy();
  const normal = resolveAiRoutePlan();
  if (policy === "primary") {
    const preferred = normal.primary ?? normal.fallback;
    if (!preferred) throw new Error("No AI route is available for internal work");
    return {
      policy,
      preferred,
      recovery: normal.primary ? normal.fallback : null,
      bypassedPrimary: normal.bypassedPrimary,
    };
  }

  const primary = resolveAiRoutes()[0];
  const economy = resolveEconomyRoute(primary);
  if (!economy) throw new Error("AI economy route is unavailable");
  const recovery = normal.bypassedPrimary ? normal.fallback : normal.primary;
  return {
    policy,
    preferred: economy,
    recovery: recovery && !(recovery.baseUrl === economy.baseUrl && recovery.model === economy.model && recovery.apiKey === economy.apiKey)
      ? recovery
      : null,
    bypassedPrimary: normal.bypassedPrimary,
  };
}

export function isRetryableAiStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
