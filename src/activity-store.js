// @feature F-009
// @feature F-012

const DEFAULT_LIMIT = 1000

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(20_000, Math.round(parsed)))
}

export async function appendActivity(store, activity, { limit = DEFAULT_LIMIT } = {}) {
  if (!activity?.id) throw new Error('Activity id is required')
  if (!activity?.createdAt) throw new Error('Activity createdAt is required')

  const safeLimit = boundedLimit(limit)
  if (typeof store.activityAppend === 'function') {
    return store.activityAppend(structuredClone(activity), { limit: safeLimit })
  }

  await store.mutate((state) => {
    state.activities ??= []
    const existing = state.activities.findIndex((item) => item.id === activity.id)
    if (existing >= 0) state.activities.splice(existing, 1)
    state.activities.unshift(structuredClone(activity))
    state.activities = state.activities.slice(0, safeLimit)
  })
  return structuredClone(activity)
}

export async function listActivities(store, { blogId = null, limit = DEFAULT_LIMIT } = {}) {
  const safeLimit = boundedLimit(limit)
  if (typeof store.activityList === 'function') {
    return store.activityList({ blogId, limit: safeLimit })
  }

  const state = await store.read()
  const rows = Array.isArray(state.activities) ? state.activities : []
  return rows
    .filter((item) => !blogId || item.blogId === blogId)
    .slice(0, safeLimit)
    .map((item) => structuredClone(item))
}
