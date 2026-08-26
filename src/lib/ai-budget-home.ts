import { aiBudgetStatus, type AiBudgetStatus } from "./ai-budget";

export type GlobalAiBudgetProtectionReason = "calls" | "tokens" | "calls-and-tokens";
export type GlobalAiBudgetWarningReason = "calls" | "tokens" | "calls-and-tokens";

interface GlobalAiBudgetSnapshot {
  reasonLabel: string;
  dayKey: string;
  timezone: string;
  calls: number;
  callLimit: number;
  totalTokens: number;
  tokenLimit: number;
}

export interface GlobalAiBudgetProtection extends GlobalAiBudgetSnapshot {
  reason: GlobalAiBudgetProtectionReason;
}

export interface GlobalAiBudgetWarning extends GlobalAiBudgetSnapshot {
  reason: GlobalAiBudgetWarningReason;
  utilizationPercent: number;
}

function reasonLabel(reason: "calls" | "tokens" | "calls-and-tokens", warning = false): string {
  if (reason === "calls-and-tokens") return warning ? "call・token残量注意" : "call上限・token上限";
  if (reason === "calls") return warning ? "call残量注意" : "call上限";
  return warning ? "token残量注意" : "token上限";
}

function snapshot(status: AiBudgetStatus, reason: "calls" | "tokens" | "calls-and-tokens", warning = false): GlobalAiBudgetSnapshot {
  return {
    reasonLabel: reasonLabel(reason, warning),
    dayKey: status.dayKey,
    timezone: status.timezone,
    calls: status.calls,
    callLimit: status.callLimit,
    totalTokens: status.totalTokens,
    tokenLimit: status.tokenLimit,
  };
}

/**
 * F-045 home view model. Keep this deliberately derived from the same
 * aiBudgetStatus() snapshot used by the F-043 preflight so the dashboard never
 * invents a second definition of global budget exhaustion.
 */
export function globalAiBudgetProtection(
  status: AiBudgetStatus = aiBudgetStatus(),
): GlobalAiBudgetProtection | null {
  const callsBlocked = status.calls >= status.callLimit;
  const tokensBlocked = status.totalTokens >= status.tokenLimit;
  if (!callsBlocked && !tokensBlocked) return null;

  const reason: GlobalAiBudgetProtectionReason = callsBlocked && tokensBlocked
    ? "calls-and-tokens"
    : callsBlocked
      ? "calls"
      : "tokens";

  return { reason, ...snapshot(status, reason) };
}

/**
 * F-047 pre-exhaustion home warning. The 80% threshold intentionally matches
 * diagnostics and F-046. Hard-cap states are excluded so the home never shows
 * both "warning" and "stopped" for the same global budget snapshot.
 */
export function globalAiBudgetWarning(
  status: AiBudgetStatus = aiBudgetStatus(),
): GlobalAiBudgetWarning | null {
  if (status.calls >= status.callLimit || status.totalTokens >= status.tokenLimit) return null;

  const callRatio = status.calls / status.callLimit;
  const tokenRatio = status.totalTokens / status.tokenLimit;
  const callsWarning = callRatio >= 0.8;
  const tokensWarning = tokenRatio >= 0.8;
  if (!callsWarning && !tokensWarning) return null;

  const reason: GlobalAiBudgetWarningReason = callsWarning && tokensWarning
    ? "calls-and-tokens"
    : callsWarning
      ? "calls"
      : "tokens";
  const utilization = Math.max(callRatio, tokenRatio);

  return {
    reason,
    utilizationPercent: Math.round(utilization * 1000) / 10,
    ...snapshot(status, reason, true),
  };
}
