// @feature F-004
// @feature F-005
// @feature F-012
import { nowIso } from './store.js'

const MIN_INTERVAL_MINUTES = 15
const MAX_INTERVAL_MINUTES = 7 * 24 * 60

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

export function normalizeSchedulerConfig(value = {}) {
  return {
    enabled: Boolean(value.enabled),
    intervalMinutes: clampInteger(value.intervalMinutes, 360, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
    maxRetries: clampInteger(value.maxRetries, 2, 0, 5),
    retryDelayMinutes: clampInteger(value.retryDelayMinutes, 10, 1, 24 * 60),
    lastRunAt: value.lastRunAt ?? null,
    nextRunAt: value.nextRunAt ?? null,
    running: false,
    retryQueue: Array.isArray(value.retryQueue) ? value.retryQueue : [],
  }
}

function nextRunAt(intervalMinutes, from = Date.now()) {
  return new Date(from + intervalMinutes * 60 * 1000).toISOString()
}

export async function configureScheduler(store, changes = {}) {
  return store.mutate((state) => {
    const current = normalizeSchedulerConfig(state.system.scheduler)
    const next = normalizeSchedulerConfig({ ...current, ...changes })
    if (next.enabled && (!current.enabled || changes.intervalMinutes !== undefined || !next.nextRunAt)) {
      next.nextRunAt = nextRunAt(next.intervalMinutes)
    }
    if (!next.enabled) next.nextRunAt = null
    state.system.scheduler = next
    return structuredClone(next)
  })
}

function isDue(config, now) {
  if (!config.enabled || !config.nextRunAt) return false
  return new Date(config.nextRunAt).getTime() <= now
}

function dueRetries(config, now) {
  return (config.retryQueue ?? []).filter((item) => new Date(item.dueAt).getTime() <= now)
}

function enqueueRetry(state, blogId, attempt, config, now) {
  if (attempt > config.maxRetries) return
  state.system.scheduler.retryQueue.push({
    blogId,
    attempt,
    dueAt: new Date(now + config.retryDelayMinutes * 60 * 1000).toISOString(),
  })
}

export function createScheduler({ store, runPortfolioCycle, runBlogCycle, recordActivity, clock = () => Date.now() }) {
  let timer = null
  let running = false

  async function tick() {
    if (running) return { skipped: true, reason: 'scheduler-busy' }
    const snapshot = await store.read()
    const config = normalizeSchedulerConfig(snapshot.system.scheduler)
    const now = clock()
    if (snapshot.system.paused) return { skipped: true, reason: 'system-paused' }
    if (!config.enabled) return { skipped: true, reason: 'scheduler-disabled' }

    const retries = dueRetries(config, now)
    if (retries.length === 0 && !isDue(config, now)) return { skipped: true, reason: 'not-due' }

    running = true
    await store.mutate((state) => {
      state.system.scheduler = normalizeSchedulerConfig(state.system.scheduler)
      state.system.scheduler.running = true
    })

    try {
      const retryResults = []
      for (const retry of retries) {
        await store.mutate((state) => {
          state.system.scheduler.retryQueue = state.system.scheduler.retryQueue.filter(
            (item) => !(item.blogId === retry.blogId && item.attempt === retry.attempt && item.dueAt === retry.dueAt),
          )
        })
        try {
          const result = await runBlogCycle(store, retry.blogId, { trigger: 'retry' })
          retryResults.push({ blogId: retry.blogId, ok: true, attempt: retry.attempt, result })
        } catch (error) {
          retryResults.push({ blogId: retry.blogId, ok: false, attempt: retry.attempt, error: error.message })
          await store.mutate((state) => enqueueRetry(
            state,
            retry.blogId,
            retry.attempt + 1,
            normalizeSchedulerConfig(state.system.scheduler),
            now,
          ))
        }
      }

      let portfolio = null
      if (isDue(config, now)) {
        portfolio = await runPortfolioCycle(store, { trigger: 'scheduler' })
        const failed = portfolio.results?.filter((item) => !item.ok) ?? []
        await store.mutate((state) => {
          const live = normalizeSchedulerConfig(state.system.scheduler)
          for (const item of failed) enqueueRetry(state, item.blogId, 1, live, now)
          state.system.scheduler.lastRunAt = nowIso()
          state.system.scheduler.nextRunAt = nextRunAt(live.intervalMinutes, now)
        })
        await recordActivity(store, {
          agent: 'scheduler',
          type: 'scheduler.cycle',
          message: `定時Portfolio cycleを実行しました。${failed.length > 0 ? ` ${failed.length}件を再試行キューへ追加しました。` : ''}`,
          detail: { failed: failed.map((item) => item.blogId) },
        })
      }

      return { skipped: false, portfolio, retries: retryResults }
    } finally {
      running = false
      await store.mutate((state) => {
        state.system.scheduler = normalizeSchedulerConfig(state.system.scheduler)
        state.system.scheduler.running = false
      })
    }
  }

  function start() {
    if (timer) return
    timer = setInterval(() => {
      tick().catch((error) => {
        recordActivity(store, {
          agent: 'scheduler',
          type: 'scheduler.failed',
          message: error.message,
        }).catch(() => undefined)
      })
    }, 30_000)
    timer.unref?.()
    tick().catch(() => undefined)
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return { start, stop, tick }
}
