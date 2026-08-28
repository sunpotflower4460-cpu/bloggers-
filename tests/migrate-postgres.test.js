import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateJsonToPostgres } from '../src/migrate-to-postgres.js'
import { JsonStore } from '../src/store.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-migrate-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function fakePostgresTarget() {
  let document = null
  const nativeJobs = []
  return {
    backend: 'postgres',
    async transaction(mutator) {
      document ??= { system: {}, blogs: [], jobs: [], locks: [] }
      return mutator(document)
    },
    async read() {
      return { ...structuredClone(document), jobs: structuredClone(nativeJobs), locks: [] }
    },
    async jobEnqueue(job, dedupeKey) {
      const existing = nativeJobs.find((item) => item.id === job.id || (dedupeKey && ['queued', 'running'].includes(item.status) && item.payload?.dedupeKey === dedupeKey))
      if (existing) return structuredClone(existing)
      const saved = structuredClone(job)
      if (dedupeKey) saved.payload = { ...(saved.payload ?? {}), dedupeKey }
      nativeJobs.push(saved)
      return structuredClone(saved)
    },
  }
}

test('JSON to PostgreSQL migration recovers running jobs and discards old operation leases', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'state.json')
    const source = await new JsonStore(path).init()
    await source.mutate((state) => {
      state.blogs.push({ id: 'blog_1', name: 'Migrated Blog' })
      state.articles.push({ id: 'article_1', blogId: 'blog_1', title: 'Hello' })
      state.system.scheduler.running = true
      state.jobs.push({
        id: 'job_running',
        type: 'blog-cycle',
        blogId: 'blog_1',
        payload: { dedupeKey: 'retry:blog_1' },
        status: 'running',
        attempt: 1,
        maxAttempts: 3,
        dueAt: '2026-08-28T00:00:00.000Z',
        leaseUntil: '2026-08-28T00:10:00.000Z',
        leasedAt: '2026-08-28T00:05:00.000Z',
        leaseOwner: 'old-worker',
        finishedAt: null,
        lastError: null,
        failureReason: null,
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:05:00.000Z',
      })
      state.jobs.push({
        id: 'job_done',
        type: 'portfolio-cycle',
        blogId: null,
        payload: null,
        status: 'completed',
        attempt: 1,
        maxAttempts: 3,
        dueAt: '2026-08-27T00:00:00.000Z',
        leaseUntil: null,
        leasedAt: '2026-08-27T00:00:00.000Z',
        leaseOwner: null,
        finishedAt: '2026-08-27T00:01:00.000Z',
        lastError: null,
        failureReason: null,
        result: { ok: true },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      })
      state.locks.push({
        id: 'lease_old',
        key: 'blog-cycle:blog_1',
        owner: 'old-worker',
        acquiredAt: '2026-08-28T00:00:00.000Z',
        expiresAt: '2026-08-28T01:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      })
    })

    const target = fakePostgresTarget()
    const result = await migrateJsonToPostgres({ sourcePath: path, targetStore: target })
    const migrated = await target.read()

    assert.equal(result.blogs, 1)
    assert.equal(result.articles, 1)
    assert.equal(result.migratedJobs, 2)
    assert.equal(result.recoveredRunningJobs, 1)
    assert.equal(result.discardedOperationLeases, 1)
    assert.equal(migrated.system.scheduler.running, false)
    assert.equal(migrated.locks.length, 0)

    const recovered = migrated.jobs.find((job) => job.id === 'job_running')
    assert.equal(recovered.status, 'queued')
    assert.equal(recovered.leaseOwner, null)
    assert.equal(recovered.leaseUntil, null)

    const completed = migrated.jobs.find((job) => job.id === 'job_done')
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.result, { ok: true })
  })
})
