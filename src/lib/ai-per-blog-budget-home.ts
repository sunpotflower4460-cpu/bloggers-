import { aiPerBlogBudgetStatus, type AiPerBlogBudgetScopeStatus } from "./ai-budget";

export type PerBlogBudgetHomeState = "near-limit" | "exhausted";

export interface PerBlogBudgetHomeScope {
  scopeKey: string;
  scopeLabel: string;
  state: PerBlogBudgetHomeState;
  calls: number;
  limit: number;
  limitSource: "override" | "default";
  utilizationPercent: number;
  dayKey: string;
  timezone: string;
}

export interface PerBlogBudgetHomeSnapshot {
  configured: boolean;
  scopes: PerBlogBudgetHomeScope[];
  configError: string | null;
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function homeScope(
  row: AiPerBlogBudgetScopeStatus,
  dayKey: string,
  timezone: string,
): PerBlogBudgetHomeScope | null {
  if (!row.exhausted && row.utilization < 0.8) return null;
  return {
    scopeKey: row.scopeKey,
    scopeLabel: row.scopeLabel,
    state: row.exhausted ? "exhausted" : "near-limit",
    calls: row.calls,
    limit: row.limit,
    limitSource: row.limitSource,
    utilizationPercent: Math.round(row.utilization * 1000) / 10,
    dayKey,
    timezone,
  };
}

/**
 * F-050 current-state view model.
 *
 * Current home state is derived from the same aiPerBlogBudgetStatus() snapshot
 * used by the hard-cap logic, so normal AI calls become visible immediately
 * without waiting for the operational monitor. Persistent F-048/F-039
 * incidents remain a separate durable history/notification layer.
 *
 * A malformed safety configuration must not crash the dashboard or be treated
 * as healthy. Returning configError lets the home fall back to persistent
 * incidents until a valid live snapshot can be produced.
 */
export function perBlogBudgetHomeSnapshot(): PerBlogBudgetHomeSnapshot {
  try {
    const budget = aiPerBlogBudgetStatus();
    return {
      configured: budget.configured,
      scopes: budget.scopes
        .map((row) => homeScope(row, budget.dayKey, budget.timezone))
        .filter((row): row is PerBlogBudgetHomeScope => row !== null),
      configError: null,
    };
  } catch (error) {
    return {
      configured: true,
      scopes: [],
      configError: safeError(error),
    };
  }
}
