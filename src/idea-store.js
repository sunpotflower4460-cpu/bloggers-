// @feature F-004
// @feature F-012

const DEFAULT_LIMIT = 3000

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(30_000, Math.round(parsed)))
}

export async function appendIdea(store, idea, { limit = DEFAULT_LIMIT } = {}) {
  if (!idea?.id) throw new Error('Idea id is required')
  if (!idea?.blogId) throw new Error('Idea blogId is required')
  if (!idea?.createdAt) throw new Error('Idea createdAt is required')

  const safeLimit = boundedLimit(limit)
  const saved = structuredClone(idea)
  if (typeof store.ideaAppend === 'function') {
    return store.ideaAppend(saved, { limit: safeLimit })
  }

  await store.mutate((state) => {
    state.ideas ??= []
    const index = state.ideas.findIndex((item) => item.id === saved.id)
    if (index >= 0) state.ideas.splice(index, 1)
    state.ideas.unshift(saved)
    state.ideas = state.ideas.slice(0, safeLimit)
  })
  return structuredClone(saved)
}

export async function listIdeas(store, { blogId = null, limit = DEFAULT_LIMIT } = {}) {
  const safeLimit = boundedLimit(limit)
  if (typeof store.ideaList === 'function') {
    return store.ideaList({ blogId, limit: safeLimit })
  }

  const state = await store.read()
  const rows = Array.isArray(state.ideas) ? state.ideas : []
  return rows
    .filter((item) => !blogId || item.blogId === blogId)
    .slice(0, safeLimit)
    .map((item) => structuredClone(item))
}
