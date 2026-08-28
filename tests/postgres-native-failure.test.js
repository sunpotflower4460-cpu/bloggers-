import test from 'node:test'
import assert from 'node:assert/strict'
import { failJob } from '../src/jobs.js'
import { PostgresStore } from '../src/postgres-store.js'

function failurePool({ owner = 'worker-a', attempt = 1, maxAttempts = 3 } = {}) {
  const memory = { commands: [], updateParams: null }
  const row = {
    id: 'job_failure',
    type: 'blog-cycle',
    blog_id: 'blog_1',
    payload: { trigger: 'retry' },
    status: 'running',
    attempt,
    max_attempts: maxAttempts,
    due_at: '2026-08-28T00:00:00.000Z',
    lease_until: '2026-08-28T00:10:00.000Z',
    leased_at: '2026-08-28T00:05:00.000Z',
    lease_owner: owner,
    finished_at: null,
    last_error: null,
    failure_reason: null,
    result: null,
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:05:00.000Z',
  }
  const client = {
    async query(sql, params = []) {
      const command = String(sql).replace(/\s+/g, ' ').trim()
      memory.commands.push(command)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)) return { rows: [] }
      if (/^SELECT \* FROM bloggers_jobs WHERE id = \$1 FOR UPDATE$/i.test(command)) return { rows: [structuredClone(row)] }
      if (/^UPDATE bloggers_jobs SET status = \$2/i.test(command)) {
        memory.updateParams = params
        return {
          rows: [{
            ...row,
            status: params[1],
            due_at: params[2],
            lease_until: null,
            lease_owner: null,
            last_error: params[3],
            failure_reason: params[4],
            finished_at: params[5],
            updated_at: params[6],
          }],
        }
      }
      throw new Error(`Unexpected SQL: ${command}`)
    },
    release() {},
  }
  return {
    memory,
    async connect() { return client },
    async query(sql, params) { return client.query(sql, params) },
  }
}

test('Postgres native retryable failure returns a leased job to queued with a later dueAt', async () => {
  const pool = failurePool()
  const store = new PostgresStore(pool)
  const now = Date.parse('2026-08-28T00:06:00.000Z')
  const error = Object.assign(new Error('temporary CMS outage'), { code: 'CMS_TEMPORARY' })

  const failed = await failJob(store, 'job_failure', error, {
    retryDelayMinutes: 10,
    now,
    retryable: true,
    owner: 'worker-a',
  })

  assert.equal(failed.status, 'queued')
  assert.equal(failed.dueAt, new Date(now + 10 * 60 * 1000).toISOString())
  assert.equal(failed.failureReason, 'CMS_TEMPORARY')
  assert.equal(failed.finishedAt, null)
  assert.ok(pool.memory.commands.includes('COMMIT'))
})

test('Postgres native non-retryable failure becomes terminal', async () => {
  const pool = failurePool()
  const store = new PostgresStore(pool)
  const now = Date.parse('2026-08-28T00:06:00.000Z')
  const error = Object.assign(new Error('AI monthly budget reserve reached'), { code: 'AI_BUDGET_RESERVE_REACHED' })

  const failed = await failJob(store, 'job_failure', error, {
    retryDelayMinutes: 10,
    now,
    retryable: false,
    owner: 'worker-a',
  })

  assert.equal(failed.status, 'failed')
  assert.equal(failed.finishedAt, new Date(now).toISOString())
  assert.equal(failed.failureReason, 'AI_BUDGET_RESERVE_REACHED')
})

test('Postgres native failure processing rejects a stale lease owner and rolls back', async () => {
  const pool = failurePool({ owner: 'worker-b' })
  const store = new PostgresStore(pool)

  await assert.rejects(
    () => failJob(store, 'job_failure', new Error('late failure'), {
      retryDelayMinutes: 10,
      now: Date.parse('2026-08-28T00:06:00.000Z'),
      retryable: true,
      owner: 'worker-a',
    }),
    (error) => error?.code === 'JOB_LEASE_LOST',
  )
  assert.ok(pool.memory.commands.includes('ROLLBACK'))
  assert.equal(pool.memory.updateParams, null)
})
