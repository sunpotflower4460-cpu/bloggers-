import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('a running leased job still participates in dedupe', async () => {
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

test('a stale worker cannot complete a job after another worker reclaims the lease', async () => {
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
      if (/^CREATE TABLE/i.test(command)) return { rows: [] }
      if (/^INSERT INTO bloggers_state/i.test(command)) {
        if (!memory.document) memory.document = JSON.parse(params[2])
        return { rows: [] }
      }
      if (/^SELECT document FROM bloggers_state/i.test(command)) {
        return { rows: memory.document ? [{ document: structuredClone(memory.document) }] : [] }
      }
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

test('PostgresStore wraps mutations in SELECT FOR UPDATE transactions', async () => {
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

test('PostgresStore rolls back when a transaction mutator fails', async () => {
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

test('storage factory keeps JSON as the dependency-free default and refuses un-injected PostgreSQL', async () => {
  assert.deepEqual(storageMode({}), { driver: 'json', transactionCapable: true, multiProcess: true, multiHost: false })
  assert.equal(storageMode({ BLOGGERS_STORAGE_DRIVER: 'postgres' }).multiHost, true)
  await assert.rejects(
    () => createStore({ env: { BLOGGERS_STORAGE_DRIVER: 'postgres' } }),
    /requires an injected postgresPool/,
  )
})
