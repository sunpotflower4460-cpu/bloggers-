import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLease, releaseLease } from '../src/leases.js'
import { completeJob, enqueueJob, leaseDueJobs, renewJobLease } from '../src/jobs.js'
import { PostgresStore } from '../src/postgres-store.js'
import { createStore, storageMode } from '../src/storage.js'
import { JsonStore } from '../src/store.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-storage-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('separate JsonStore instances serialize mutations through the filesystem lock', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'state.json')
    const first = await new JsonStore(path).init()
    const second = await new JsonStore(path).init()

    await Promise.all(Array.from({ length: 40 }, (_, index) => {
      const store = index % 2 === 0 ? first : second
      return store.transaction((state) => {
        state.concurrentCounter = Number(state.concurrentCounter || 0) + 1
      })
    }))

    const state = await first.read()
    assert.equal(state.concurrentCounter, 40)
  })
})

test('a running leased job still participates in JSON dedupe', async () => {
  await withTempDir(async (dir) => {
    const store = await new JsonStore(join(dir, 'state.json')).init()
    const first = await enqueueJob(store, {
      type: 'portfolio-cycle',
      dedupeKey: 'portfolio:2026-08-28T00:00:00.000Z',
      dueAt: '2026-08-28T00:00:00.000Z',
    })
    const leased = await leaseDueJobs(store, { now: Date.parse('2026-08-28T00:01:00.000Z'), owner: 'worker-a' })
    assert.equal(leased[0].id, first.id)
    assert.equal(leased[0].status, 'running')
    assert.equal(leased[0].leaseOwner, 'worker-a')

    const duplicate = await enqueueJob(store, {
      type: 'portfolio-cycle',
      dedupeKey: 'portfolio:2026-08-28T00:00:00.000Z',
      dueAt: '2026-08-28T00:00:00.000Z',
    })
    const state = await store.read()
    assert.equal(duplicate.id, first.id)
    assert.equal(state.jobs.length, 1)
  })
})

test('job lease heartbeat extends ownership and rejects another worker renewal', async () => {
  await withTempDir(async (dir) => {
    const store = await new JsonStore(join(dir, 'state.json')).init()
    const job = await enqueueJob(store, { type: 'blog-cycle', blogId: 'b1', dueAt: '1970-01-01T00:00:01.000Z' })
    await leaseDueJobs(store, { now: 1000, leaseMs: 1000, owner: 'worker-a' })

    const renewed = await renewJobLease(store, job.id, { now: 1500, leaseMs: 1000, owner: 'worker-a' })
    assert.equal(renewed.leaseOwner, 'worker-a')
    assert.equal(renewed.leaseUntil, new Date(2500).toISOString())

    await assert.rejects(
      () => renewJobLease(store, job.id, { now: 1600, leaseMs: 1000, owner: 'worker-b' }),
      (error) => error?.code === 'JOB_LEASE_LOST',
    )
  })
})

test('a stale worker cannot complete a JSON job after another worker reclaims the lease', async () => {
  await withTempDir(async (dir) => {
    const store = await new JsonStore(join(dir, 'state.json')).init()
    const job = await enqueueJob(store, { type: 'blog-cycle', blogId: 'b1', dueAt: '1970-01-01T00:00:01.000Z' })
    await leaseDueJobs(store, { now: 1000, leaseMs: 1000, owner: 'worker-a' })
    const reclaimed = await leaseDueJobs(store, { now: 2500, leaseMs: 1000, owner: 'worker-b' })
    assert.equal(reclaimed[0].id, job.id)
    assert.equal(reclaimed[0].attempt, 2)
    assert.equal(reclaimed[0].leaseOwner, 'worker-b')

    await assert.rejects(
      () => completeJob(store, job.id, { stale: true }, { owner: 'worker-a' }),
      (error) => error?.code === 'JOB_LEASE_LOST',
    )
    const stillRunning = (await store.read()).jobs.find((item) => item.id === job.id)
    assert.equal(stillRunning.status, 'running')
    assert.equal(stillRunning.leaseOwner, 'worker-b')

    const completed = await completeJob(store, job.id, { ok: true }, { owner: 'worker-b' })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.leaseOwner, null)
  })
})

function fakePostgresPool() {
  const memory = { document: null, releases: 0, commands: [] }
  const client = {
    async query(sql, params = []) {
      const command = String(sql).replace(/\s+/g, ' ').trim()
      memory.commands.push(command)
      if (/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX)/i.test(command)) return { rows: [] }
      if (/^INSERT INTO bloggers_state/i.test(command)) {
        if (!memory.document) memory.document = JSON.parse(params[2])
        return { rows: [] }
      }
      if (/^SELECT document FROM bloggers_state/i.test(command)) {
        return { rows: memory.document ? [{ document: structuredClone(memory.document) }] : [] }
      }
      if (/^SELECT id, type, blog_id, payload, status/i.test(command) && /FROM bloggers_jobs/i.test(command)) return { rows: [] }
      if (/^SELECT lease_key, lease_id, owner/i.test(command) && /FROM bloggers_operation_leases/i.test(command)) return { rows: [] }
      if (/^UPDATE bloggers_state/i.test(command)) {
        memory.document = JSON.parse(params[2])
        return { rows: [] }
      }
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)) return { rows: [] }
      throw new Error(`Unexpected SQL: ${command}`)
    },
    release() { memory.releases += 1 },
  }
  return {
    memory,
    async connect() { return client },
    async query(sql, params) { return client.query(sql, params) },
  }
}

test('PostgresStore wraps state mutations in SELECT FOR UPDATE transactions', async () => {
  const pool = fakePostgresPool()
  const store = await new PostgresStore(pool).init()

  const returned = await store.transaction((state) => {
    state.system.paused = true
    return 'committed'
  })

  assert.equal(returned, 'committed')
  assert.equal((await store.read()).system.paused, true)
  assert.ok(pool.memory.commands.some((command) => /FOR UPDATE$/i.test(command)))
  assert.ok(pool.memory.commands.includes('BEGIN'))
  assert.ok(pool.memory.commands.includes('COMMIT'))
})

test('PostgresStore rolls back when a state transaction mutator fails', async () => {
  const pool = fakePostgresPool()
  const store = await new PostgresStore(pool).init()
  await assert.rejects(
    () => store.transaction((state) => {
      state.system.paused = true
      throw new Error('stop')
    }),
    /stop/,
  )
  assert.equal((await store.read()).system.paused, false)
  assert.ok(pool.memory.commands.includes('ROLLBACK'))
})

function nativeQueuePool() {
  const memory = { commands: [] }
  const runningRow = {
    id: 'job_native',
    type: 'portfolio-cycle',
    blog_id: null,
    payload: { dedupeKey: 'portfolio:native' },
    status: 'running',
    attempt: 1,
    max_attempts: 3,
    due_at: '2026-08-28T00:00:00.000Z',
    lease_until: '2026-08-28T00:06:00.000Z',
    leased_at: '2026-08-28T00:01:00.000Z',
    lease_owner: 'worker-a',
    finished_at: null,
    last_error: null,
    failure_reason: null,
    result: null,
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:01:00.000Z',
  }
  const client = {
    async query(sql, params = []) {
      const command = String(sql).replace(/\s+/g, ' ').trim()
      memory.commands.push(command)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)) return { rows: [] }
      if (/^UPDATE bloggers_jobs SET status = 'queued'/i.test(command)) return { rows: [] }
      if (/^WITH due AS/i.test(command) && /FOR UPDATE SKIP LOCKED/i.test(command)) return { rows: [structuredClone(runningRow)] }
      if (/^UPDATE bloggers_jobs SET lease_until/i.test(command)) {
        return { rows: [{ ...runningRow, lease_until: params[2], updated_at: params[1] }] }
      }
      if (/^UPDATE bloggers_jobs SET status = 'completed'/i.test(command)) {
        return { rows: [{ ...runningRow, status: 'completed', lease_owner: null, lease_until: null, result: JSON.parse(params[1]) }] }
      }
      if (/^DELETE FROM bloggers_operation_leases WHERE expires_at/i.test(command)) return { rows: [] }
      if (/^INSERT INTO bloggers_operation_leases/i.test(command)) {
        return { rows: [{ lease_key: params[0], lease_id: params[1], owner: params[2], acquired_at: params[3], expires_at: params[4], updated_at: params[3] }] }
      }
      if (/^DELETE FROM bloggers_operation_leases WHERE lease_key/i.test(command)) return { rows: [{ lease_key: params[0] }] }
      throw new Error(`Unexpected native SQL: ${command}`)
    },
    release() {},
  }
  return {
    memory,
    async connect() { return client },
    async query(sql, params) { return client.query(sql, params) },
  }
}

test('Postgres native job leasing uses SKIP LOCKED and owner fencing through public job APIs', async () => {
  const pool = nativeQueuePool()
  const store = new PostgresStore(pool)
  const now = Date.parse('2026-08-28T00:01:00.000Z')

  const leased = await leaseDueJobs(store, { limit: 4, leaseMs: 300_000, now, owner: 'worker-a' })
  assert.equal(leased[0].leaseOwner, 'worker-a')
  assert.ok(pool.memory.commands.some((command) => /FOR UPDATE SKIP LOCKED/i.test(command)))

  const renewed = await renewJobLease(store, leased[0].id, { owner: 'worker-a', leaseMs: 300_000, now })
  assert.equal(renewed.leaseOwner, 'worker-a')

  const completed = await completeJob(store, leased[0].id, { ok: true }, { owner: 'worker-a' })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.result, { ok: true })
})

test('Postgres native operation leases dispatch through the same public lease API', async () => {
  const pool = nativeQueuePool()
  const store = new PostgresStore(pool)
  const acquired = await acquireLease(store, 'blog-cycle:b1', { owner: 'worker-a', ttlMs: 30_000, now: Date.parse('2026-08-28T00:00:00.000Z') })
  assert.equal(acquired.acquired, true)
  assert.equal(acquired.lease.owner, 'worker-a')
  assert.equal(await releaseLease(store, 'blog-cycle:b1', 'worker-a'), true)
})

test('generic public job API dispatches to a native queue capability when available', async () => {
  const calls = []
  const nativeStore = {
    async jobEnqueue(job, dedupeKey) {
      calls.push({ job, dedupeKey })
      return { ...job, payload: { ...(job.payload ?? {}), dedupeKey } }
    },
  }
  const result = await enqueueJob(nativeStore, { type: 'blog-cycle', blogId: 'b1', dedupeKey: 'retry:b1' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].dedupeKey, 'retry:b1')
  assert.equal(result.payload.dedupeKey, 'retry:b1')
})

test('storage factory keeps JSON as the dependency-free default and refuses un-injected PostgreSQL', async () => {
  assert.deepEqual(storageMode({}), { driver: 'json', transactionCapable: true, multiProcess: true, multiHost: false })
  assert.equal(storageMode({ BLOGGERS_STORAGE_DRIVER: 'postgres' }).multiHost, true)
  await assert.rejects(
    () => createStore({ env: { BLOGGERS_STORAGE_DRIVER: 'postgres' } }),
    /requires an injected postgresPool/,
  )
})
