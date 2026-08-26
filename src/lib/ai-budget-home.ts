import { aiBudgetStatus, type AiBudgetStatus } from "./ai-budget";

export type GlobalAiBudgetProtectionReason = "calls" | "tokens" | "calls-and-tokens";

export interface GlobalAiBudgetProtection {
  reason: GlobalAiBudgetProtectionReason;
  reasonLabel: string;
  dayKey: string;
  timezone: string;
  calls: number;
  callLimit: number;
  totalTokens: number;
  tokenLimit: number;
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

  return {
    reason,
    reasonLabel: reason === "calls-and-tokens"
      ? "call上限・token上限"
      : reason === "calls"
        ? "call上限"
        : "token上限",
    dayKey: status.dayKey,
    timezone: status.timezone,
    calls: status.calls,
    callLimit: status.callLimit,
    totalTokens: status.totalTokens,
    tokenLimit: status.tokenLimit,
  };
}
