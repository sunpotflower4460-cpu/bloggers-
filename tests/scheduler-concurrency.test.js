import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueueJob } from '../src/jobs.js'
import { configureScheduler, createScheduler, workerConcurrency } from '../src/scheduler.js'
import { JsonStore } from '../src/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-scheduler-concurrency-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('worker concurrency is bounded and configurable', () => {
  assert.equal(workerConcurrency({}), 4)
  assert.equal(workerConcurrency({ BLOGGERS_WORKER_CONCURRENCY: '2' }), 2)
  assert.equal(workerConcurrency({ BLOGGERS_WORKER_CONCURRENCY: '0' }), 1)
  assert.equal(workerConcurrency({ BLOGGERS_WORKER_CONCURRENCY: '99' }), 20)
})

test('scheduler leases only the jobs it can actively process', async () => {
  await withStore(async (store) => {
    const previous = process.env.BLOGGERS_WORKER_CONCURRENCY
    process.env.BLOGGERS_WORKER_CONCURRENCY = '2'
    try {
      await configureScheduler(store, { enabled: true, intervalMinutes: 15, maxRetries: 2, retryDelayMinutes: 1 })
      await store.mutate((state) => {
        state.system.scheduler.nextRunAt = '2099-01-01T00:00:00.000Z'
      })

      for (const blogId of ['b1', 'b2', 'b3']) {
        await enqueueJob(store, {
          type: 'blog-cycle',
          blogId,
          dueAt: '2026-08-28T01:00:00.000Z',
          maxAttempts: 3,
          payload: { trigger: 'test' },
        })
      }

      let active = 0
      let maxActive = 0
      let entered = 0
      const bothEntered = deferred()
      const release = deferred()
      const seenKeys = []
      const scheduler = createScheduler({
        store,
        clock: () => Date.parse('2026-08-28T02:00:00.000Z'),
        runPortfolioCycle: async () => ({ skipped: false, results: [] }),
        runBlogCycle: async (_store, blogId, options = {}) => {
          seenKeys.push({ blogId, key: options.idempotencyKey, trigger: options.trigger })
          active += 1
          entered += 1
          maxActive = Math.max(maxActive, active)
          if (entered === 2) bothEntered.resolve()
          await release.promise
          active -= 1
          return { workflowId: 'ok' }
        },
        recordActivity: async () => undefined,
      })

      const firstPromise = scheduler.tick()
      await Promise.race([
        bothEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('two leased jobs did not enter processing concurrently')), 1000)),
      ])
      assert.equal(maxActive, 2)
      release.resolve()

      const first = await firstPromise
      const afterFirst = await store.read()
      assert.equal(first.concurrency, 2)
      assert.equal(first.jobs.length, 2)
      assert.equal(afterFirst.jobs.filter((job) => job.status === 'completed').length, 2)
      assert.equal(afterFirst.jobs.filter((job) => job.status === 'queued').length, 1)
      assert.equal(afterFirst.jobs.filter((job) => job.status === 'running').length, 0)
      assert.equal(new Set(seenKeys.slice(0, 2).map((item) => item.key)).size, 2)
      assert.ok(seenKeys.slice(0, 2).every((item) => item.key?.startsWith('job:')))

      const second = await scheduler.tick()
      const afterSecond = await store.read()
      assert.equal(second.jobs.length, 1)
      assert.equal(afterSecond.jobs.filter((job) => job.status === 'completed').length, 3)
      assert.equal(afterSecond.jobs.filter((job) => job.status === 'queued').length, 0)
    } finally {
      if (previous === undefined) delete process.env.BLOGGERS_WORKER_CONCURRENCY
      else process.env.BLOGGERS_WORKER_CONCURRENCY = previous
    }
  })
})
