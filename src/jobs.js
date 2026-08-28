// @feature F-012
import { createId, nowIso } from './store.js'

export const DEFAULT_JOB_LEASE_MS = 5 * 60 * 1000

function dueAtMs(job) {
  return new Date(job.dueAt || job.createdAt || 0).getTime()
}

function leaseExpired(job, now) {
  return !job.leaseUntil || new Date(job.leaseUntil).getTime() <= now
}

function isActiveJob(job) {
  return job.status === 'queued' || job.status === 'running'
}

function leaseLostError(jobId) {
  const error = new Error(`Job lease ownership was lost: ${jobId}`)
  error.code = 'JOB_LEASE_LOST'
  return error
}

function assertLeaseOwnership(job, owner) {
  if (!owner) return
  if (job.status !== 'running' || job.leaseOwner !== owner) throw leaseLostError(job.id)
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
    leaseOwner: null,
    finishedAt: null,
    lastError: null,
    failureReason: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  if (typeof store.jobEnqueue === 'function') return store.jobEnqueue(job, input.dedupeKey ?? null)

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

export async function leaseDueJobs(store, {
  limit = 10,
  leaseMs = DEFAULT_JOB_LEASE_MS,
  now = Date.now(),
  owner = `process:${process.pid}`,
} = {}) {
  if (typeof store.jobLeaseDue === 'function') return store.jobLeaseDue({ limit, leaseMs, now, owner })

  return store.mutate((state) => {
    state.jobs ??= []
    for (const job of state.jobs) {
      if (job.status === 'running' && leaseExpired(job, now)) {
        job.status = 'queued'
        job.leaseUntil = null
        job.leasedAt = null
        job.leaseOwner = null
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
      job.leaseOwner = owner
      job.updatedAt = nowIso()
    }
    return structuredClone(due)
  })
}

export async function renewJobLease(store, jobId, {
  owner,
  leaseMs = DEFAULT_JOB_LEASE_MS,
  now = Date.now(),
} = {}) {
  if (!owner) throw new Error('Job lease renewal requires an owner')
  if (typeof store.jobRenew === 'function') return store.jobRenew(jobId, { owner, leaseMs, now })

  return store.mutate((state) => {
    const job = (state.jobs ?? []).find((item) => item.id === jobId)
    if (!job) throw new Error('Job not found')
    assertLeaseOwnership(job, owner)
    job.leaseUntil = new Date(now + leaseMs).toISOString()
    job.updatedAt = nowIso()
    return structuredClone(job)
  })
}

export async function completeJob(store, jobId, result = null, { owner = null } = {}) {
  if (typeof store.jobComplete === 'function') return store.jobComplete(jobId, result, { owner })

  return store.mutate((state) => {
    const job = (state.jobs ?? []).find((item) => item.id === jobId)
    if (!job) throw new Error('Job not found')
    assertLeaseOwnership(job, owner)
    job.status = 'completed'
    job.result = result
    job.leaseUntil = null
    job.leaseOwner = null
    job.finishedAt = nowIso()
    job.updatedAt = nowIso()
    return structuredClone(job)
  })
}

export async function failJob(store, jobId, error, {
  retryDelayMinutes = 10,
  now = Date.now(),
  retryable = true,
  owner = null,
} = {}) {
  if (typeof store.jobFail === 'function') {
    return store.jobFail(jobId, error, { retryDelayMinutes, now, retryable, owner })
  }

  return store.mutate((state) => {
    const job = (state.jobs ?? []).find((item) => item.id === jobId)
    if (!job) throw new Error('Job not found')
    assertLeaseOwnership(job, owner)
    job.lastError = error?.message ?? String(error)
    job.failureReason = error?.code ?? null
    job.leaseUntil = null
    job.leaseOwner = null
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
