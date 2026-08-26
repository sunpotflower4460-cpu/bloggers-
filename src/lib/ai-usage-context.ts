import { AsyncLocalStorage } from "node:async_hooks";

export interface AiUsageScope {
  scopeKey: string;
  scopeLabel: string;
}

const systemScope: AiUsageScope = {
  scopeKey: "system/unattributed",
  scopeLabel: "system/unattributed",
};

const globalStore = globalThis as typeof globalThis & {
  __blogGardenAiUsageContext?: AsyncLocalStorage<AiUsageScope>;
};

const storage = globalStore.__blogGardenAiUsageContext ?? new AsyncLocalStorage<AiUsageScope>();
if (process.env.NODE_ENV !== "production") globalStore.__blogGardenAiUsageContext = storage;

function clean(value: string, fallback: string, max: number): string {
  return String(value || fallback)
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || fallback;
}

export function blogAiUsageScope(blogId: string, blogName: string): AiUsageScope {
  return {
    scopeKey: `blog:${clean(blogId, "unknown", 180)}`,
    scopeLabel: clean(blogName, "Unnamed blog", 180),
  };
}

export function currentAiUsageScope(): AiUsageScope {
  return storage.getStore() ?? systemScope;
}

export function withAiUsageScope<T>(scope: AiUsageScope, work: () => T): T {
  const normalized: AiUsageScope = {
    scopeKey: clean(scope.scopeKey, systemScope.scopeKey, 240),
    scopeLabel: clean(scope.scopeLabel, systemScope.scopeLabel, 240),
  };
  return storage.run(normalized, work);
}
