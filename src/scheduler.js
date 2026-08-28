// @feature F-004
// @feature F-005
// @feature F-012
import { withExecutionContext } from './execution-context.js'
import { completeJob, DEFAULT_JOB_LEASE_MS, enqueueJob, failJob, leaseDueJobs, renewJobLease } from './jobs.js'
import { createId } from './store.js'

const MIN_INTERVAL_MINUTES = 15
const MAX_INTERVAL_MINUTES = 7 * 24 * 60

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function jobLeaseMs() {
  const parsed = Number(process.env.BLOGGERS_JOB_LEASE_MS || DEFAULT_JOB_LEASE_MS)
  if (!Number.isFinite(parsed)) return DEFAULT_JOB_LEASE_MS
  return Math.max(60_000, Math.min(60 * 60 * 1000, Math.round(parsed)))
}

export function workerConcurrency(env = process.env) {
  return clampInteger(env.BLOGGERS_WORKER_CONCURRENCY, 4, 1, 20)
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

function isRetryableFailure(errorOrMessage) {
  const code = errorOrMessage?.code
  const message = String(errorOrMessage?.message ?? errorOrMessage?.error ?? errorOrMessage ?? '')
  if (code === 'AI_BUDGET_RESERVE_REACHED' || code === 'JOB_LEASE_LOST' || code === 'OPERATION_LEASE_LOST') return false
  if (/AI monthly budget reserve reached/i.test(message)) return false
  if (/operation lease (?:is already active|ownership was lost)/i.test(message)) return false
  if (/already has an editorial cycle in progress/i.test(message)) return false
  if (/approval is already being processed/i.test(message)) return false
  return true
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
  const workerId = createId('worker')
  const leaseMs = jobLeaseMs()
  const concurrency = workerConcurrency()

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

  function startLeaseHeartbeat(job) {
    const intervalMs = Math.max(10_000, Math.min(60_000, Math.floor(leaseMs / 3)))
    const heartbeat = setInterval(() => {
      renewJobLease(store, job.id, { owner: workerId, leaseMs }).catch((error) => {
        if (error?.code !== 'JOB_LEASE_LOST') {
          recordActivity(store, {
            blogId: job.blogId,
            agent: 'scheduler',
            type: 'scheduler.lease-heartbeat-failed',
            message: `Job lease heartbeatに失敗しました: ${error.message}`,
            detail: { jobId: job.id, workerId },
          }).catch(() => undefined)
        }
      })
    }, intervalMs)
    heartbeat.unref?.()
    return heartbeat
  }

  async function leaseLostResult(job, error) {
    await recordActivity(store, {
      blogId: job.blogId,
      agent: 'scheduler',
      type: 'scheduler.job-lease-lost',
      message: `古いWorkerのJob確定を拒否しました: ${job.type}`,
      detail: { jobId: job.id, workerId, error: error.message },
    }).catch(() => undefined)
    return { jobId: job.id, type: job.type, blogId: job.blogId, ok: false, error: error.message, status: 'lease-lost', retryable: false }
  }

  async function processJob(job, config, now) {
    let heartbeat = null
    const beforeExternalWrite = async (detail = {}) => {
      const renewed = await renewJobLease(store, job.id, { owner: workerId, leaseMs })
      return { ...detail, jobId: job.id, workerId, leaseUntil: renewed.leaseUntil }
    }

    try {
      await renewJobLease(store, job.id, { owner: workerId, leaseMs })
      heartbeat = startLeaseHeartbeat(job)
      return await withExecutionContext({ jobId: job.id, workerId, beforeExternalWrite }, async () => {
        if (job.type === 'portfolio-cycle') {
          const portfolioKey = job.payload?.idempotencyKey || `portfolio:${job.id}`
          const portfolio = await runPortfolioCycle(store, { trigger: 'scheduler', idempotencyKey: portfolioKey })
          const failed = portfolio.results?.filter((item) => !item.ok) ?? []
          const retryable = failed.filter((item) => isRetryableFailure(item))
          const nonRetryable = failed.filter((item) => !isRetryableFailure(item))
          for (const item of retryable) {
            await enqueueJob(store, {
              type: 'blog-cycle',
              blogId: item.blogId,
              dueAt: new Date(now + config.retryDelayMinutes * 60 * 1000).toISOString(),
              maxAttempts: config.maxRetries + 1,
              payload: {
                trigger: 'retry',
                parentJobId: job.id,
                idempotencyKey: `${portfolioKey}:${item.blogId}`,
              },
              dedupeKey: `retry:${job.id}:${item.blogId}`,
            })
          }
          await completeJob(store, job.id, {
            failedBlogs: failed.map((item) => item.blogId),
            retryableBlogs: retryable.map((item) => item.blogId),
            nonRetryableBlogs: nonRetryable.map((item) => item.blogId),
          }, { owner: workerId })
          await recordActivity(store, {
            agent: 'scheduler',
            type: 'scheduler.cycle',
            message: `定時Portfolio cycleを実行しました。${retryable.length > 0 ? ` ${retryable.length}件をdurable job queueへ追加しました。` : ''}${nonRetryable.length > 0 ? ` ${nonRetryable.length}件はnon-retryableとして停止しました。` : ''}`,
            detail: {
              jobId: job.id,
              workerId,
              failed: failed.map((item) => item.blogId),
              retryable: retryable.map((item) => item.blogId),
              nonRetryable: nonRetryable.map((item) => item.blogId),
            },
          })
          return { jobId: job.id, type: job.type, ok: true, portfolio }
        }

        if (job.type === 'blog-cycle') {
          const idempotencyKey = job.payload?.idempotencyKey || `job:${job.id}:${job.blogId}`
          const result = await runBlogCycle(store, job.blogId, {
            trigger: job.payload?.trigger || 'retry',
            idempotencyKey,
          })
          await completeJob(store, job.id, { workflowId: result.workflowId ?? null }, { owner: workerId })
          return { jobId: job.id, type: job.type, blogId: job.blogId, ok: true, result }
        }

        throw new Error(`Unsupported job type: ${job.type}`)
      })
    } catch (error) {
      if (error?.code === 'JOB_LEASE_LOST') return leaseLostResult(job, error)
      const retryable = isRetryableFailure(error)
      let failed
      try {
        failed = await failJob(store, job.id, error, {
          retryDelayMinutes: config.retryDelayMinutes,
          now,
          retryable,
          owner: workerId,
        })
      } catch (failureError) {
        if (failureError?.code === 'JOB_LEASE_LOST') return leaseLostResult(job, failureError)
        throw failureError
      }
      await recordActivity(store, {
        blogId: job.blogId,
        agent: 'scheduler',
        type: retryable ? 'scheduler.job-failed' : 'scheduler.job-stopped',
        message: `${job.type} が失敗しました: ${error.message}`,
        detail: { jobId: job.id, workerId, attempt: failed.attempt, status: failed.status, retryable },
      })
      return { jobId: job.id, type: job.type, blogId: job.blogId, ok: false, error: error.message, status: failed.status, retryable }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
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
    const jobs = await leaseDueJobs(store, { limit: concurrency, leaseMs, now, owner: workerId })
    if (jobs.length === 0) return { skipped: true, reason: 'not-due' }

    running = true
    await store.mutate((state) => {
      state.system.scheduler = normalizeSchedulerConfig(state.system.scheduler)
      state.system.scheduler.running = true
    })

    try {
      const results = await Promise.all(jobs.map((job) => processJob(job, config, now)))
      const portfolioResult = results.find((item) => item.type === 'portfolio-cycle')?.portfolio ?? null
      return {
        skipped: false,
        workerId,
        concurrency,
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

  function start({ keepAlive = false } = {}) {
    if (timer) return
    timer = setInterval(() => {
      tick().catch((error) => {
        recordActivity(store, { agent: 'scheduler', type: 'scheduler.failed', message: error.message, detail: { workerId } }).catch(() => undefined)
      })
    }, 30_000)
    if (!keepAlive) timer.unref?.()
    tick().catch(() => undefined)
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return { start, stop, tick, workerId, concurrency }
}
