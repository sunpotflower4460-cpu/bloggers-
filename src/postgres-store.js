// @feature F-012
import { assertPersistableSecretReferences } from './secrets.js'
import { DEFAULT_STATE, normalizeState } from './store.js'

const STATE_KEY = 'global'

function decodeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

function decodeDocument(value) {
  if (!value) return structuredClone(DEFAULT_STATE)
  return decodeJson(value)
}

function iso(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function jobFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    blogId: row.blog_id ?? null,
    payload: decodeJson(row.payload),
    status: row.status,
    attempt: Number(row.attempt ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    dueAt: iso(row.due_at),
    leaseUntil: iso(row.lease_until),
    leasedAt: iso(row.leased_at),
    leaseOwner: row.lease_owner ?? null,
    finishedAt: iso(row.finished_at),
    lastError: row.last_error ?? null,
    failureReason: row.failure_reason ?? null,
    result: decodeJson(row.result),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function leaseFromRow(row) {
  return {
    id: row.lease_id,
    key: row.lease_key,
    owner: row.owner,
    acquiredAt: iso(row.acquired_at),
    expiresAt: iso(row.expires_at),
    updatedAt: iso(row.updated_at),
  }
}

async function selectJobs(queryable) {
  const result = await queryable.query(`
    SELECT id, type, blog_id, payload, status, attempt, max_attempts, due_at,
           lease_until, leased_at, lease_owner, finished_at, last_error,
           failure_reason, result, created_at, updated_at
    FROM bloggers_jobs
    ORDER BY created_at ASC
  `)
  return (result.rows ?? []).map(jobFromRow)
}

async function selectLeases(queryable) {
  const result = await queryable.query(`
    SELECT lease_key, lease_id, owner, acquired_at, expires_at, updated_at
    FROM bloggers_operation_leases
    WHERE expires_at > now()
    ORDER BY acquired_at ASC
  `)
  return (result.rows ?? []).map(leaseFromRow)
}

export class PostgresStore {
  #pool

  constructor(pool) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('PostgresStore requires a pool with connect()')
    this.#pool = pool
  }

  get backend() {
    return 'postgres'
  }

  get capabilities() {
    return { nativeJobs: true, nativeLeases: true, multiHost: true }
  }

  async init() {
    const client = await this.#pool.connect()
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS bloggers_state (
          state_key text PRIMARY KEY,
          version integer NOT NULL,
          document jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS bloggers_jobs (
          id text PRIMARY KEY,
          type text NOT NULL,
          blog_id text,
          payload jsonb,
          status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
          attempt integer NOT NULL DEFAULT 0,
          max_attempts integer NOT NULL DEFAULT 3,
          due_at timestamptz NOT NULL,
          lease_until timestamptz,
          leased_at timestamptz,
          lease_owner text,
          finished_at timestamptz,
          last_error text,
          failure_reason text,
          result jsonb,
          dedupe_key text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS bloggers_jobs_active_dedupe_idx
        ON bloggers_jobs (dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS bloggers_jobs_due_idx
        ON bloggers_jobs (due_at, created_at)
        WHERE status = 'queued'
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS bloggers_operation_leases (
          lease_key text PRIMARY KEY,
          lease_id text NOT NULL,
          owner text NOT NULL,
          acquired_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await client.query(
        `INSERT INTO bloggers_state (state_key, version, document)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (state_key) DO NOTHING`,
        [STATE_KEY, DEFAULT_STATE.version, JSON.stringify(DEFAULT_STATE)],
      )
    } finally {
      client.release?.()
    }
    return this
  }

  async read() {
    const [stateResult, jobs, locks] = await Promise.all([
      this.#pool.query('SELECT document FROM bloggers_state WHERE state_key = $1', [STATE_KEY]),
      selectJobs(this.#pool),
      selectLeases(this.#pool),
    ])
    const state = normalizeState(decodeDocument(stateResult.rows?.[0]?.document))
    state.jobs = jobs
    state.locks = locks
    return state
  }

  async mutate(mutator) {
    return this.transaction(mutator)
  }

  async transaction(mutator) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        'SELECT document FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const state = normalizeState(decodeDocument(result.rows?.[0]?.document))
      const value = await mutator(state)
      assertPersistableSecretReferences(state)
      await client.query(
        `UPDATE bloggers_state
         SET version = $2, document = $3::jsonb, updated_at = now()
         WHERE state_key = $1`,
        [STATE_KEY, Number(state.version || DEFAULT_STATE.version), JSON.stringify(state)],
      )
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async jobEnqueue(job, dedupeKey = null) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      if (dedupeKey) {
        const existing = await client.query(
          `SELECT id, type, blog_id, payload, status, attempt, max_attempts, due_at,
                  lease_until, leased_at, lease_owner, finished_at, last_error,
                  failure_reason, result, created_at, updated_at
           FROM bloggers_jobs
           WHERE dedupe_key = $1 AND status IN ('queued', 'running')
           LIMIT 1
           FOR UPDATE`,
          [dedupeKey],
        )
        if (existing.rows?.[0]) {
          await client.query('COMMIT')
          return jobFromRow(existing.rows[0])
        }
      }

      const payload = { ...(job.payload ?? {}), ...(dedupeKey ? { dedupeKey } : {}) }
      const inserted = await client.query(
        `INSERT INTO bloggers_jobs (
           id, type, blog_id, payload, status, attempt, max_attempts, due_at,
           lease_until, leased_at, lease_owner, finished_at, last_error,
           failure_reason, result, dedupe_key, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz,
           $9::timestamptz, $10::timestamptz, $11, $12::timestamptz, $13,
           $14, $15::jsonb, $16, $17::timestamptz, $18::timestamptz
         )
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
         DO NOTHING
         RETURNING *`,
        [
          job.id, job.type, job.blogId, JSON.stringify(payload), job.status,
          job.attempt, job.maxAttempts, job.dueAt, job.leaseUntil, job.leasedAt,
          job.leaseOwner, job.finishedAt, job.lastError, job.failureReason,
          job.result === null || job.result === undefined ? null : JSON.stringify(job.result),
          dedupeKey, job.createdAt, job.updatedAt,
        ],
      )
      if (inserted.rows?.[0]) {
        await client.query('COMMIT')
        return jobFromRow(inserted.rows[0])
      }

      const raced = await client.query(
        `SELECT * FROM bloggers_jobs
         WHERE dedupe_key = $1 AND status IN ('queued', 'running')
         LIMIT 1`,
        [dedupeKey],
      )
      await client.query('COMMIT')
      if (!raced.rows?.[0]) throw new Error('Active job dedupe conflict could not be resolved')
      return jobFromRow(raced.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async jobLeaseDue({ limit, leaseMs, now, owner }) {
    const client = await this.#pool.connect()
    const nowIso = new Date(now).toISOString()
    const leaseUntil = new Date(now + leaseMs).toISOString()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE bloggers_jobs
         SET status = 'queued', lease_until = NULL, leased_at = NULL,
             lease_owner = NULL, updated_at = $1::timestamptz
         WHERE status = 'running' AND lease_until <= $1::timestamptz`,
        [nowIso],
      )
      const result = await client.query(
        `WITH due AS (
           SELECT id
           FROM bloggers_jobs
           WHERE status = 'queued' AND due_at <= $1::timestamptz
           ORDER BY due_at ASC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE bloggers_jobs AS job
         SET status = 'running', attempt = job.attempt + 1,
             leased_at = $1::timestamptz, lease_until = $3::timestamptz,
             lease_owner = $4, updated_at = $1::timestamptz
         FROM due
         WHERE job.id = due.id
         RETURNING job.*`,
        [nowIso, Math.max(1, limit), leaseUntil, owner],
      )
      await client.query('COMMIT')
      return (result.rows ?? []).map(jobFromRow)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async jobRenew(jobId, { owner, leaseMs, now }) {
    const result = await this.#pool.query(
      `UPDATE bloggers_jobs
       SET lease_until = $3::timestamptz, updated_at = $2::timestamptz
       WHERE id = $1 AND status = 'running' AND lease_owner = $4
       RETURNING *`,
      [jobId, new Date(now).toISOString(), new Date(now + leaseMs).toISOString(), owner],
    )
    if (!result.rows?.[0]) {
      const error = new Error(`Job lease ownership was lost: ${jobId}`)
      error.code = 'JOB_LEASE_LOST'
      throw error
    }
    return jobFromRow(result.rows[0])
  }

  async jobComplete(jobId, resultValue, { owner = null, now = Date.now() } = {}) {
    const params = [
      jobId,
      resultValue === null || resultValue === undefined ? null : JSON.stringify(resultValue),
      new Date(now).toISOString(),
      owner,
    ]
    const result = await this.#pool.query(
      `UPDATE bloggers_jobs
       SET status = 'completed', result = $2::jsonb, lease_until = NULL,
           lease_owner = NULL, finished_at = $3::timestamptz, updated_at = $3::timestamptz
       WHERE id = $1 AND ($4::text IS NULL OR (status = 'running' AND lease_owner = $4))
       RETURNING *`,
      params,
    )
    if (!result.rows?.[0]) {
      const error = new Error(`Job lease ownership was lost: ${jobId}`)
      error.code = 'JOB_LEASE_LOST'
      throw error
    }
    return jobFromRow(result.rows[0])
  }

  async jobFail(jobId, error, { retryDelayMinutes, now, retryable, owner = null }) {
    const client = await this.#pool.connect()
    const nowIso = new Date(now).toISOString()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        `SELECT * FROM bloggers_jobs
         WHERE id = $1
         FOR UPDATE`,
        [jobId],
      )
      const row = locked.rows?.[0]
      if (!row) throw new Error('Job not found')
      if (owner && (row.status !== 'running' || row.lease_owner !== owner)) {
        const lost = new Error(`Job lease ownership was lost: ${jobId}`)
        lost.code = 'JOB_LEASE_LOST'
        throw lost
      }

      const willRetry = Boolean(retryable) && Number(row.attempt) < Number(row.max_attempts)
      const nextDue = willRetry ? new Date(now + retryDelayMinutes * 60 * 1000).toISOString() : iso(row.due_at)
      const updated = await client.query(
        `UPDATE bloggers_jobs
         SET status = $2, due_at = $3::timestamptz, lease_until = NULL,
             lease_owner = NULL, last_error = $4, failure_reason = $5,
             finished_at = $6::timestamptz, updated_at = $7::timestamptz
         WHERE id = $1
         RETURNING *`,
        [
          jobId,
          willRetry ? 'queued' : 'failed',
          nextDue,
          error?.message ?? String(error),
          error?.code ?? null,
          willRetry ? null : nowIso,
          nowIso,
        ],
      )
      await client.query('COMMIT')
      return jobFromRow(updated.rows[0])
    } catch (caught) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw caught
    } finally {
      client.release?.()
    }
  }

  async leaseAcquire({ key, leaseId, owner, acquiredAt, expiresAt, now }) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'DELETE FROM bloggers_operation_leases WHERE expires_at <= $1::timestamptz',
        [new Date(now).toISOString()],
      )
      const inserted = await client.query(
        `INSERT INTO bloggers_operation_leases
           (lease_key, lease_id, owner, acquired_at, expires_at, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $4::timestamptz)
         ON CONFLICT (lease_key) DO NOTHING
         RETURNING *`,
        [key, leaseId, owner, acquiredAt, expiresAt],
      )
      if (inserted.rows?.[0]) {
        await client.query('COMMIT')
        return { acquired: true, lease: leaseFromRow(inserted.rows[0]), owner }
      }
      const existing = await client.query(
        'SELECT * FROM bloggers_operation_leases WHERE lease_key = $1',
        [key],
      )
      await client.query('COMMIT')
      return { acquired: false, lease: existing.rows?.[0] ? leaseFromRow(existing.rows[0]) : null, owner }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async leaseRelease(key, owner) {
    const result = await this.#pool.query(
      `DELETE FROM bloggers_operation_leases
       WHERE lease_key = $1 AND owner = $2
       RETURNING lease_key`,
      [key, owner],
    )
    return Boolean(result.rows?.[0])
  }
}
