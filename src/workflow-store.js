// @feature F-004
// @feature F-009
// @feature F-012

const DEFAULT_LIMIT = 2000

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(20_000, Math.round(parsed)))
}

export async function upsertWorkflow(store, workflow, { limit = DEFAULT_LIMIT } = {}) {
  if (!workflow?.id) throw new Error('Workflow id is required')
  if (!workflow?.blogId) throw new Error('Workflow blogId is required')
  if (!workflow?.startedAt) throw new Error('Workflow startedAt is required')

  const safeLimit = boundedLimit(limit)
  const saved = structuredClone(workflow)
  if (typeof store.workflowUpsert === 'function') {
    return store.workflowUpsert(saved, { limit: safeLimit })
  }

  await store.mutate((state) => {
    state.workflows ??= []
    const index = state.workflows.findIndex((item) => item.id === saved.id)
    if (index >= 0) state.workflows.splice(index, 1)
    state.workflows.unshift(saved)
    state.workflows = state.workflows.slice(0, safeLimit)
  })
  return structuredClone(saved)
}

export async function listWorkflows(store, { blogId = null, limit = DEFAULT_LIMIT } = {}) {
  const safeLimit = boundedLimit(limit)
  if (typeof store.workflowList === 'function') {
    return store.workflowList({ blogId, limit: safeLimit })
  }

  const state = await store.read()
  const rows = Array.isArray(state.workflows) ? state.workflows : []
  return rows
    .filter((item) => !blogId || item.blogId === blogId)
    .slice(0, safeLimit)
    .map((item) => structuredClone(item))
}
