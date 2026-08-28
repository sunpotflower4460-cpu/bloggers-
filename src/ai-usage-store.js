// @feature F-005
// @feature F-012

const DEFAULT_LIMIT = 10_000

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(100_000, Math.round(parsed)))
}

export async function appendAiUsageEntries(store, entries, { limit = DEFAULT_LIMIT } = {}) {
  const rows = Array.isArray(entries) ? entries.filter(Boolean).map((item) => structuredClone(item)) : []
  if (rows.length === 0) return []
  for (const entry of rows) {
    if (!entry.id) throw new Error('AI usage id is required')
    if (!entry.createdAt) throw new Error('AI usage createdAt is required')
  }

  const safeLimit = boundedLimit(limit)
  if (typeof store.aiUsageAppend === 'function') {
    return store.aiUsageAppend(rows, { limit: safeLimit })
  }

  await store.mutate((state) => {
    state.aiUsage ??= []
    const incomingIds = new Set(rows.map((item) => item.id))
    state.aiUsage = [...rows, ...state.aiUsage.filter((item) => !incomingIds.has(item.id))].slice(0, safeLimit)
  })
  return rows
}

export async function listAiUsageEntries(store, { blogId = null, limit = DEFAULT_LIMIT } = {}) {
  const safeLimit = boundedLimit(limit)
  if (typeof store.aiUsageList === 'function') {
    return store.aiUsageList({ blogId, limit: safeLimit })
  }

  const state = await store.read()
  const rows = Array.isArray(state.aiUsage) ? state.aiUsage : []
  return rows
    .filter((item) => !blogId || item.blogId === blogId)
    .slice(0, safeLimit)
    .map((item) => structuredClone(item))
}
