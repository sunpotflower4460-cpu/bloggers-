// @feature F-004
// @feature F-005
// @feature F-012
import { completeJob, enqueueJob, failJob, leaseDueJobs } from './jobs.js'
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

async function migrateLegacyRetries(store, config) {
  const legacy = config.retryQueue ?? []
  if (legacy.length === 0) return
  for (const item of legacy) {
    await enqueueJob(store, {
      type: 'blog-cycle',
      blogId: item.blogId,
      attempt: Math.max(0, Number(item.attempt || 1) - 1),
      maxAttempts: config.maxRetries + 1,
      dueAt: item.dueAt,
      payload: { trigger: 'retry-migrated' },
      dedupeKey: `legacy-retry:${item.blogId}:${item.dueAt}`,
    })
  }
  await store.mutate((state) => {
    state.system.scheduler.retryQueue = []
  })
}

export function createScheduler({ store, runPortfolioCycle, runBlogCycle, recordActivity, clock = () => Date.now() }) {
  let timer = null
  let running = false

  async function schedulePortfolioIfDue(config, now) {
    if (!isDue(config, now)) return null
    const scheduledFor = config.nextRunAt
    const job = await enqueueJob(store, {
      type: 'portfolio-cycle',
      dueAt: new Date(now).toISOString(),
      maxAttempts: config.maxRetries + 1,
      payload: { trigger: 'scheduler', scheduledFor },
      dedupeKey: `portfolio:${scheduledFor}`,
    })
    await store.mutate((state) => {
      const live = normalizeSchedulerConfig(state.system.scheduler)
      state.system.scheduler.lastRunAt = new Date(now).toISOString()
      state.system.scheduler.nextRunAt = nextRunAt(live.intervalMinutes, now)
    })
    return job
  }

  async function processJob(job, config, now) {
    try {
      if (job.type === 'portfolio-cycle') {
        const portfolio = await runPortfolioCycle(store, { trigger: 'scheduler' })
        const failed = portfolio.results?.filter((item) => !item.ok) ?? []
        for (const item of failed) {
          await enqueueJob(store, {
            type: 'blog-cycle',
            blogId: item.blogId,
            dueAt: new Date(now + config.retryDelayMinutes * 60 * 1000).toISOString(),
            maxAttempts: config.maxRetries + 1,
            payload: { trigger: 'retry', parentJobId: job.id },
            dedupeKey: `retry:${job.id}:${item.blogId}`,
          })
        }
        await completeJob(store, job.id, { failedBlogs: failed.map((item) => item.blogId) })
        await recordActivity(store, {
          agent: 'scheduler',
          type: 'scheduler.cycle',
          message: `定時Portfolio cycleを実行しました。${failed.length > 0 ? ` ${failed.length}件をdurable job queueへ追加しました。` : ''}`,
          detail: { jobId: job.id, failed: failed.map((item) => item.blogId) },
        })
        return { jobId: job.id, type: job.type, ok: true, portfolio }
      }

      if (job.type === 'blog-cycle') {
        const result = await runBlogCycle(store, job.blogId, { trigger: job.payload?.trigger || 'retry' })
        await completeJob(store, job.id, { workflowId: result.workflowId ?? null })
        return { jobId: job.id, type: job.type, blogId: job.blogId, ok: true, result }
      }

      throw new Error(`Unsupported job type: ${job.type}`)
    } catch (error) {
      const failed = await failJob(store, job.id, error, { retryDelayMinutes: config.retryDelayMinutes, now })
      await recordActivity(store, {
        blogId: job.blogId,
        agent: 'scheduler',
        type: 'scheduler.job-failed',
        message: `${job.type} が失敗しました: ${error.message}`,
        detail: { jobId: job.id, attempt: failed.attempt, status: failed.status },
      })
      return { jobId: job.id, type: job.type, blogId: job.blogId, ok: false, error: error.message, status: failed.status }
    }
  }

  async function tick() {
    if (running) return { skipped: true, reason: 'scheduler-busy' }
    const snapshot = await store.read()
    const config = normalizeSchedulerConfig(snapshot.system.scheduler)
    const now = clock()
    if (snapshot.system.paused) return { skipped: true, reason: 'system-paused' }
    if (!config.enabled) return { skipped: true, reason: 'scheduler-disabled' }

    await migrateLegacyRetries(store, config)
    const scheduled = await schedulePortfolioIfDue(config, now)
    const jobs = await leaseDueJobs(store, { limit: 20, now })
    if (jobs.length === 0) return { skipped: true, reason: 'not-due' }

    running = true
    await store.mutate((state) => {
      state.system.scheduler = normalizeSchedulerConfig(state.system.scheduler)
      state.system.scheduler.running = true
    })

    try {
      const results = []
      for (const job of jobs) results.push(await processJob(job, config, now))
      const portfolioResult = results.find((item) => item.type === 'portfolio-cycle')?.portfolio ?? null
      return {
        skipped: false,
        scheduledJobId: scheduled?.id ?? null,
        portfolio: portfolioResult,
        jobs: results,
        retries: results.filter((item) => item.type === 'blog-cycle'),
      }
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
        recordActivity(store, { agent: 'scheduler', type: 'scheduler.failed', message: error.message }).catch(() => undefined)
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
