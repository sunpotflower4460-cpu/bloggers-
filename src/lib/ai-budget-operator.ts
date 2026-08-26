import { setBlogAiDailyCallLimitOverride } from "./ai-budget-overrides";
import { reconcileAiPerBlogBudgetIncidents } from "./ai-per-blog-budget-alert";

export interface BlogAiBudgetOverrideApplyResult {
  limit: number | null;
  reconciled: boolean;
  exhaustedScopes: number | null;
  notifications: number;
  notificationFailures: number;
  configError: string | null;
  reconcileError: string | null;
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Operator-facing F-042 path: persist the F-041 override first, then reconcile
 * the same persistent F-039 incident state immediately.
 *
 * A reconcile failure must not undo a successfully persisted safety setting.
 * The monitor remains the fallback reconciler, so this function reports the
 * degradation instead of pretending the setting itself failed to save.
 */
export async function applyBlogAiDailyCallLimitOverride(
  blogId: string,
  limit: number | null,
): Promise<BlogAiBudgetOverrideApplyResult> {
  setBlogAiDailyCallLimitOverride(blogId, limit);

  try {
    const reconciliation = await reconcileAiPerBlogBudgetIncidents();
    return {
      limit,
      reconciled: reconciliation.configError === null,
      exhaustedScopes: reconciliation.exhaustedScopes,
      notifications: reconciliation.notifications,
      notificationFailures: reconciliation.notificationFailures,
      configError: reconciliation.configError,
      reconcileError: null,
    };
  } catch (error) {
    const detail = safeError(error);
    console.error(`[ai-budget-operator] override saved but immediate incident reconciliation failed: ${detail}`);
    return {
      limit,
      reconciled: false,
      exhaustedScopes: null,
      notifications: 0,
      notificationFailures: 0,
      configError: null,
      reconcileError: detail,
    };
  }
}
