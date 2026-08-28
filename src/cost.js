// @feature F-005
// @feature F-012
import { createId, nowIso } from './store.js'

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function normalizeAiBudget(value = {}) {
  return {
    enabled: value.enabled !== false,
    monthlyUsd: number(value.monthlyUsd, 20),
    perCycleUsd: number(value.perCycleUsd, 2),
    reserveUsd: number(value.reserveUsd, 0.5),
  }
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

export function summarizeAiUsage(state, date = new Date()) {
  const key = monthKey(date)
  const entries = (state.aiUsage ?? []).filter((item) => String(item.createdAt || '').startsWith(key))
  const totalUsd = entries.reduce((sum, item) => sum + number(item.estimatedCostUsd), 0)
  const inputTokens = entries.reduce((sum, item) => sum + number(item.inputTokens), 0)
  const outputTokens = entries.reduce((sum, item) => sum + number(item.outputTokens), 0)
  return { month: key, totalUsd, inputTokens, outputTokens, calls: entries.length }
}

export function budgetStatus(state, date = new Date()) {
  const budget = normalizeAiBudget(state.system?.aiBudget)
  const usage = summarizeAiUsage(state, date)
  const remainingUsd = budget.monthlyUsd > 0 ? Math.max(0, budget.monthlyUsd - usage.totalUsd) : null
  const blocked = budget.enabled && budget.monthlyUsd > 0 && remainingUsd <= budget.reserveUsd
  return { budget, usage, remainingUsd, blocked }
}

export function assertAiBudget(state) {
  const status = budgetStatus(state)
  if (status.blocked) {
    throw new Error(`AI monthly budget reserve reached. spent=$${status.usage.totalUsd.toFixed(4)} budget=$${status.budget.monthlyUsd.toFixed(2)}`)
  }
  return status
}

export async function recordAiUsage(store, entries = [], context = {}) {
  const normalized = entries.map((entry) => ({
    id: createId('usage'),
    createdAt: nowIso(),
    blogId: context.blogId ?? null,
    workflowId: context.workflowId ?? null,
    operation: entry.operation ?? 'unknown',
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    inputTokens: number(entry.inputTokens),
    outputTokens: number(entry.outputTokens),
    estimatedCostUsd: number(entry.estimatedCostUsd),
  }))
  if (normalized.length === 0) return []
  await store.mutate((state) => {
    state.aiUsage ??= []
    state.aiUsage.unshift(...normalized)
    state.aiUsage = state.aiUsage.slice(0, 10_000)
  })
  return normalized
}
