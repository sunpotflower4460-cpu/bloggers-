// @feature F-004
// @feature F-006
// @feature F-010
// @feature F-012
import { acquireLease, releaseLease } from './leases.js'
import { resolveApproval, runBlogCycle } from './orchestrator.js'
import { buildPortfolioPlan } from './portfolio.js'

async function withLease(store, key, work, { ttlMs = 15 * 60 * 1000, busyMessage = 'Operation is already running' } = {}) {
  const claimed = await acquireLease(store, key, { ttlMs })
  if (!claimed.acquired) throw new Error(busyMessage)
  try {
    return await work()
  } finally {
    await releaseLease(store, key, claimed.owner)
  }
}

export async function runBlogCycleExclusive(store, blogId, options = {}) {
  return withLease(
    store,
    `blog-cycle:${blogId}`,
    () => runBlogCycle(store, blogId, options),
    { ttlMs: 30 * 60 * 1000, busyMessage: 'This blog already has an editorial cycle in progress.' },
  )
}

export async function runPortfolioCycleExclusive(store, options = {}) {
  const snapshot = await store.read()
  if (snapshot.system.paused) return { skipped: true, reason: 'system-paused', results: [] }

  const plan = buildPortfolioPlan(snapshot)
  const results = []
  for (const item of plan.ranking) {
    try {
      const result = await runBlogCycleExclusive(store, item.blogId, {
        ...options,
        trigger: options.trigger || 'portfolio',
      })
      results.push({ blogId: item.blogId, ok: true, result })
    } catch (error) {
      results.push({ blogId: item.blogId, ok: false, error: error.message, code: error.code ?? null })
    }
  }
  return { skipped: false, plan, results }
}

export async function resolveApprovalExclusive(store, approvalId, approved) {
  return withLease(
    store,
    `approval:${approvalId}`,
    () => resolveApproval(store, approvalId, approved),
    { ttlMs: 10 * 60 * 1000, busyMessage: 'This approval is already being processed.' },
  )
}
