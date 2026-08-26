import {
  aiUsageByModel,
  aiUsageByScope,
  type AiModelUsageDaily,
  type AiScopeModelUsageDaily,
} from "./ai-budget";

export interface AiModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface AiModelCostSummary {
  modelKey: string;
  calls: number;
  meteredCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  priceConfigured: boolean;
  estimatedCost: number | null;
}

export interface AiScopeCostSummary {
  scopeKey: string;
  scopeLabel: string;
  calls: number;
  meteredCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  todayEstimatedCost: number;
  last7dEstimatedCost: number;
  coveragePercent: number | null;
  unpricedTokens: number;
  unmeteredCalls: number;
  unpricedModelKeys: string[];
  complete: boolean;
}

export interface AiCostEstimate {
  configured: boolean;
  currency: string;
  todayEstimatedCost: number;
  last7dEstimatedCost: number;
  observedDays: number;
  projected30dCost: number;
  coveragePercent: number | null;
  unpricedTokens: number;
  unmeteredCalls: number;
  unpricedModelKeys: string[];
  complete: boolean;
  models: AiModelCostSummary[];
  scopes: AiScopeCostSummary[];
  attributionCallCoveragePercent: number | null;
  attributionTokenCoveragePercent: number | null;
  unattributedHistoricalCalls: number;
  unattributedHistoricalTokens: number;
}

type UsageRow = Pick<AiModelUsageDaily,
  "dayKey" | "modelKey" | "calls" | "meteredCalls" | "inputTokens" | "outputTokens" | "totalTokens"
>;

function currency(): string {
  const value = (process.env.AI_PRICE_CURRENCY?.trim() || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) throw new Error("AI_PRICE_CURRENCY must be a 3-letter currency code");
  return value;
}

function priceNumber(value: unknown, field: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new Error(`AI price ${key}.${field} must be a finite non-negative number <= 1000000`);
  }
  return parsed;
}

export function aiPriceTable(): { configured: boolean; currency: string; prices: Map<string, AiModelPrice> } {
  const unit = currency();
  const raw = process.env.AI_PRICE_TABLE_JSON?.trim();
  if (!raw) return { configured: false, currency: unit, prices: new Map() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI_PRICE_TABLE_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI_PRICE_TABLE_JSON must be an object keyed by providerLabel:model");
  }

  const prices = new Map<string, AiModelPrice>();
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const key = rawKey.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
    if (!key || key.length > 240) throw new Error("AI price-table keys must be 1-240 characters");
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new Error(`AI price ${key} must be an object`);
    }
    const item = rawValue as Record<string, unknown>;
    prices.set(key, {
      inputPerMillion: priceNumber(item.inputPerMillion, "inputPerMillion", key),
      outputPerMillion: priceNumber(item.outputPerMillion, "outputPerMillion", key),
    });
  }
  if (!prices.size) throw new Error("AI_PRICE_TABLE_JSON must contain at least one model price");
  return { configured: true, currency: unit, prices };
}

function modelCost(row: Pick<UsageRow, "inputTokens" | "outputTokens">, price: AiModelPrice): number {
  return (row.inputTokens / 1_000_000) * price.inputPerMillion
    + (row.outputTokens / 1_000_000) * price.outputPerMillion;
}

function aggregate(rows: AiModelUsageDaily[]): Map<string, AiModelUsageDaily> {
  const result = new Map<string, AiModelUsageDaily>();
  for (const row of rows) {
    const current = result.get(row.modelKey) ?? {
      dayKey: row.dayKey,
      modelKey: row.modelKey,
      calls: 0,
      meteredCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    current.calls += row.calls;
    current.meteredCalls += row.meteredCalls;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.totalTokens += Math.max(row.totalTokens, row.inputTokens + row.outputTokens);
    result.set(row.modelKey, current);
  }
  return result;
}

function estimateRows(rows: UsageRow[], prices: Map<string, AiModelPrice>): {
  estimatedCost: number;
  pricedTokens: number;
  reportedTokens: number;
  calls: number;
  meteredCalls: number;
  inputTokens: number;
  outputTokens: number;
  unmeteredCalls: number;
  unpricedModelKeys: Set<string>;
} {
  let estimatedCost = 0;
  let pricedTokens = 0;
  let reportedTokens = 0;
  let calls = 0;
  let meteredCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let unmeteredCalls = 0;
  const unpricedModelKeys = new Set<string>();

  for (const row of rows) {
    const knownTokens = row.inputTokens + row.outputTokens;
    const totalTokens = Math.max(row.totalTokens, knownTokens);
    calls += row.calls;
    meteredCalls += row.meteredCalls;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    reportedTokens += totalTokens;
    unmeteredCalls += Math.max(0, row.calls - row.meteredCalls);
    const price = prices.get(row.modelKey);
    if (!price) {
      if (row.calls > 0 || totalTokens > 0) unpricedModelKeys.add(row.modelKey);
      continue;
    }
    estimatedCost += modelCost(row, price);
    // Only input/output token categories can be priced by this operator table.
    // Any extra provider-reported total tokens remain outside the estimate.
    pricedTokens += knownTokens;
  }

  return {
    estimatedCost,
    pricedTokens,
    reportedTokens,
    calls,
    meteredCalls,
    inputTokens,
    outputTokens,
    unmeteredCalls,
    unpricedModelKeys,
  };
}

function groupScopes(rows: AiScopeModelUsageDaily[]): Map<string, AiScopeModelUsageDaily[]> {
  const grouped = new Map<string, AiScopeModelUsageDaily[]>();
  for (const row of rows) {
    const current = grouped.get(row.scopeKey) ?? [];
    current.push(row);
    grouped.set(row.scopeKey, current);
  }
  return grouped;
}

export function aiCostEstimate(): AiCostEstimate {
  const config = aiPriceTable();
  const todayRows = aiUsageByModel(1);
  const last7Rows = aiUsageByModel(7);
  const today = estimateRows(todayRows, config.prices);
  const last7 = estimateRows(last7Rows, config.prices);
  const observedDays = new Set(last7Rows.filter((row) => row.calls > 0 || row.totalTokens > 0).map((row) => row.dayKey)).size;
  const projected30dCost = observedDays > 0 ? (last7.estimatedCost / observedDays) * 30 : 0;
  const coveragePercent = last7.reportedTokens > 0 ? (last7.pricedTokens / last7.reportedTokens) * 100 : null;
  const unpricedTokens = Math.max(0, last7.reportedTokens - last7.pricedTokens);
  const byModel = aggregate(last7Rows);
  const models = [...byModel.values()].map((row): AiModelCostSummary => {
    const price = config.prices.get(row.modelKey);
    return {
      modelKey: row.modelKey,
      calls: row.calls,
      meteredCalls: row.meteredCalls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      priceConfigured: Boolean(price),
      estimatedCost: price ? modelCost(row, price) : null,
    };
  }).sort((a, b) => (b.estimatedCost ?? -1) - (a.estimatedCost ?? -1) || b.totalTokens - a.totalTokens);

  const todayScopeRows = aiUsageByScope(1);
  const last7ScopeRows = aiUsageByScope(7);
  const todayScopes = groupScopes(todayScopeRows);
  const last7Scopes = groupScopes(last7ScopeRows);
  const scopeKeys = new Set([...todayScopes.keys(), ...last7Scopes.keys()]);
  const scopes = [...scopeKeys].map((scopeKey): AiScopeCostSummary => {
    const todayGroup = todayScopes.get(scopeKey) ?? [];
    const last7Group = last7Scopes.get(scopeKey) ?? [];
    const source = last7Group[0] ?? todayGroup[0];
    const todayEstimate = estimateRows(todayGroup, config.prices);
    const scopeEstimate = estimateRows(last7Group, config.prices);
    const scopeCoverage = scopeEstimate.reportedTokens > 0
      ? (scopeEstimate.pricedTokens / scopeEstimate.reportedTokens) * 100
      : null;
    const scopeUnpricedTokens = Math.max(0, scopeEstimate.reportedTokens - scopeEstimate.pricedTokens);
    return {
      scopeKey,
      scopeLabel: source?.scopeLabel || scopeKey,
      calls: scopeEstimate.calls,
      meteredCalls: scopeEstimate.meteredCalls,
      inputTokens: scopeEstimate.inputTokens,
      outputTokens: scopeEstimate.outputTokens,
      totalTokens: scopeEstimate.reportedTokens,
      todayEstimatedCost: todayEstimate.estimatedCost,
      last7dEstimatedCost: scopeEstimate.estimatedCost,
      coveragePercent: scopeCoverage,
      unpricedTokens: scopeUnpricedTokens,
      unmeteredCalls: scopeEstimate.unmeteredCalls,
      unpricedModelKeys: [...scopeEstimate.unpricedModelKeys].sort(),
      complete: config.configured
        && scopeEstimate.unpricedModelKeys.size === 0
        && scopeUnpricedTokens === 0
        && scopeEstimate.unmeteredCalls === 0,
    };
  }).sort((a, b) => b.last7dEstimatedCost - a.last7dEstimatedCost || b.totalTokens - a.totalTokens || a.scopeLabel.localeCompare(b.scopeLabel));

  const attributed = estimateRows(last7ScopeRows, config.prices);
  const attributionCallCoveragePercent = last7.calls > 0 ? Math.min(100, (attributed.calls / last7.calls) * 100) : null;
  const attributionTokenCoveragePercent = last7.reportedTokens > 0
    ? Math.min(100, (attributed.reportedTokens / last7.reportedTokens) * 100)
    : null;
  const unattributedHistoricalCalls = Math.max(0, last7.calls - attributed.calls);
  const unattributedHistoricalTokens = Math.max(0, last7.reportedTokens - attributed.reportedTokens);

  return {
    configured: config.configured,
    currency: config.currency,
    todayEstimatedCost: today.estimatedCost,
    last7dEstimatedCost: last7.estimatedCost,
    observedDays,
    projected30dCost,
    coveragePercent,
    unpricedTokens,
    unmeteredCalls: last7.unmeteredCalls,
    unpricedModelKeys: [...last7.unpricedModelKeys].sort(),
    complete: config.configured
      && last7.unpricedModelKeys.size === 0
      && unpricedTokens === 0
      && last7.unmeteredCalls === 0,
    models,
    scopes,
    attributionCallCoveragePercent,
    attributionTokenCoveragePercent,
    unattributedHistoricalCalls,
    unattributedHistoricalTokens,
  };
}
