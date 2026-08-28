// @feature F-012
import { createId, nowIso } from './store.js'

const DEFAULT_LEASE_MS = 5 * 60 * 1000

function dueAtMs(job) {
  return new Date(job.dueAt || job.createdAt || 0).getTime()
}

function leaseExpired(job, now) {
  return !job.leaseUntil || new Date(job.leaseUntil).getTime() <= now
}

function isActiveJob(job) {
  return job.status === 'queued' || job.status === 'running'
}

export async function enqueueJob(store, input) {
  const job = {
    id: createId('job'),
    type: input.type,
    blogId: input.blogId ?? null,
    payload: input.payload ?? null,
    status: 'queued',
    attempt: Number(input.attempt ?? 0),
    maxAttempts: Number(input.maxAttempts ?? 3),
    dueAt: input.dueAt ?? nowIso(),
    leaseUntil: null,
    leasedAt: null,
    finishedAt: null,
    lastError: null,
    failureReason: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  return store.mutate((state) => {
    state.jobs ??= []
    if (input.dedupeKey) {
      const existing = state.jobs.find((item) => isActiveJob(item) && item.payload?.dedupeKey === input.dedupeKey)
      if (existing) return structuredClone(existing)
      job.payload = { ...(job.payload ?? {}), dedupeKey: input.dedupeKey }
    }
    state.jobs.push(job)
    state.jobs = state.jobs.slice(-10_000)
    return structuredClone(job)
  })
}

export async function leaseDueJobs(store, { limit = 10, leaseMs = DEFAULT_LEASE_MS, now = Date.now() } = {}) {
  return store.mutate((state) => {
    state.jobs ??= []
    for (const job of state.jobs) {
      if (job.status === 'running' && leaseExpired(job, now)) {
        job.status = 'queued'
        job.leaseUntil = null
        job.leasedAt = null
        job.updatedAt = nowIso()
      }
    }

    const due = state.jobs
      .filter((job) => job.status === 'queued' && dueAtMs(job) <= now)
      .sort((a, b) => dueAtMs(a) - dueAtMs(b))
      .slice(0, Math.max(1, limit))

    for (const job of due) {
      job.status = 'running'
      job.attempt += 1
      job.leasedAt = new Date(now).toISOString()
      job.leaseUntil = new Date(now + leaseMs).toISOString()
      job.updatedAt = nowIso()
    }
    return structuredClone(due)
  })
}

export async function completeJob(store, jobId, result = null) {
  return store.mutate((state) => {
    const job = (state.jobs ?? []).find((item) => item.id === jobId)
    if (!job) throw new Error('Job not found')
    job.status = 'completed'
    job.result = result
    job.leaseUntil = null
    job.finishedAt = nowIso()
    job.updatedAt = nowIso()
    return structuredClone(job)
  })
}

export async function failJob(store, jobId, error, { retryDelayMinutes = 10, now = Date.now(), retryable = true } = {}) {
  return store.mutate((state) => {
    const job = (state.jobs ?? []).find((item) => item.id === jobId)
    if (!job) throw new Error('Job not found')
    job.lastError = error?.message ?? String(error)
    job.failureReason = error?.code ?? null
    job.leaseUntil = null
    job.updatedAt = nowIso()
    if (retryable && job.attempt < job.maxAttempts) {
      job.status = 'queued'
      job.dueAt = new Date(now + retryDelayMinutes * 60 * 1000).toISOString()
    } else {
      job.status = 'failed'
      job.finishedAt = nowIso()
    }
    return structuredClone(job)
  })
}

export function summarizeJobs(state) {
  const jobs = state.jobs ?? []
  return {
    queued: jobs.filter((item) => item.status === 'queued').length,
    running: jobs.filter((item) => item.status === 'running').length,
    failed: jobs.filter((item) => item.status === 'failed').length,
    completed: jobs.filter((item) => item.status === 'completed').length,
  }
}
