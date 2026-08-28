// @feature F-007
// @feature F-012

const DEFAULT_LIMIT = 5000

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(50_000, Math.round(parsed)))
}

export async function appendAnalyticsSnapshot(store, snapshot, { limit = DEFAULT_LIMIT } = {}) {
  if (!snapshot?.id) throw new Error('Analytics snapshot id is required')
  if (!snapshot?.blogId) throw new Error('Analytics snapshot blogId is required')

  const safeLimit = boundedLimit(limit)
  if (typeof store.analyticsAppend === 'function') {
    return store.analyticsAppend(structuredClone(snapshot), { limit: safeLimit })
  }

  await store.mutate((state) => {
    state.analytics ??= []
    const existing = state.analytics.findIndex((item) => item.id === snapshot.id)
    if (existing >= 0) state.analytics.splice(existing, 1)
    state.analytics.unshift(structuredClone(snapshot))
    state.analytics = state.analytics.slice(0, safeLimit)
  })
  return structuredClone(snapshot)
}

export async function listAnalyticsSnapshots(store, { blogId = null, limit = DEFAULT_LIMIT } = {}) {
  const safeLimit = boundedLimit(limit)
  if (typeof store.analyticsList === 'function') {
    return store.analyticsList({ blogId, limit: safeLimit })
  }

  const state = await store.read()
  const rows = Array.isArray(state.analytics) ? state.analytics : []
  return rows
    .filter((item) => !blogId || item.blogId === blogId)
    .slice(0, safeLimit)
    .map((item) => structuredClone(item))
}
