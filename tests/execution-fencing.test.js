import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnector, GhostConnector } from '../src/connectors.js'
import { beforeExternalWrite, withExecutionContext } from '../src/execution-context.js'
import { enqueueJob } from '../src/jobs.js'
import { addBlog } from '../src/orchestrator.js'
import { configureScheduler, createScheduler } from '../src/scheduler.js'
import { JsonStore } from '../src/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-fence-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function leaseLostError() {
  const error = new Error('lease moved to another worker')
  error.code = 'JOB_LEASE_LOST'
  return error
}

test('nested execution contexts compose job and operation write fences', async () => {
  const calls = []
  await withExecutionContext({
    jobId: 'job-1',
    workerId: 'worker-1',
    beforeExternalWrite: async (detail) => { calls.push(`job:${detail.operation}`) },
  }, async () => {
    await withExecutionContext({
      operationLeaseKey: 'blog-cycle:b1',
      beforeExternalWrite: async (detail) => { calls.push(`operation:${detail.operation}`) },
    }, async () => {
      await beforeExternalWrite({ operation: 'publish' })
    })
  })
  assert.deepEqual(calls, ['job:publish', 'operation:publish'])
})

test('connector writes are rejected before mutation when the execution fence is lost', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, { name: 'Fenced Memory', connector: { type: 'memory' } })
    const connector = createConnector({ blog, store })
    let seen = null

    await assert.rejects(
      () => withExecutionContext({
        jobId: 'job-fenced',
        workerId: 'worker-old',
        beforeExternalWrite: async (detail) => {
          seen = detail
          throw leaseLostError()
        },
      }, () => connector.createDraft({ id: 'article-1', title: 'Blocked', body: 'Must not be written' })),
      (error) => error?.code === 'JOB_LEASE_LOST',
    )

    const state = await store.read()
    assert.equal(state.blogs[0].remotePosts.length, 0)
    assert.equal(seen.jobId, 'job-fenced')
    assert.equal(seen.workerId, 'worker-old')
    assert.equal(seen.operation, 'create-draft')
  })
})

test('Ghost write fencing happens before the outbound HTTP request', async () => {
  const before = process.env.GHOST_FENCE_KEY
  process.env.GHOST_FENCE_KEY = 'abc123:00112233445566778899aabbccddeeff'
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('fetch should not be reached')
  }

  try {
    const connector = new GhostConnector({
      blog: { id: 'ghost-blog', connector: { type: 'ghost', endpoint: 'https://example.com', adminKeyEnv: 'GHOST_FENCE_KEY', apiVersion: 'v6.0' } },
      store: null,
    })
    await assert.rejects(
      () => withExecutionContext({ beforeExternalWrite: async () => { throw leaseLostError() } }, () => connector.createDraft({ title: 'Blocked', body: 'No HTTP' })),
      (error) => error?.code === 'JOB_LEASE_LOST',
    )
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (before === undefined) delete process.env.GHOST_FENCE_KEY
    else process.env.GHOST_FENCE_KEY = before
  }
})

test('scheduler execution context fences a stale worker before CMS mutation', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, { name: 'Scheduler Fence', connector: { type: 'memory' } })
    await configureScheduler(store, { enabled: true, intervalMinutes: 15, maxRetries: 2, retryDelayMinutes: 1 })
    await store.mutate((state) => {
      state.system.scheduler.nextRunAt = '2099-01-01T00:00:00.000Z'
    })
    const job = await enqueueJob(store, {
      type: 'blog-cycle',
      blogId: blog.id,
      dueAt: '2026-08-28T01:00:00.000Z',
      maxAttempts: 3,
      payload: { trigger: 'test' },
    })

    const scheduler = createScheduler({
      store,
      clock: () => Date.parse('2026-08-28T02:00:00.000Z'),
      runPortfolioCycle: async () => ({ skipped: false, results: [] }),
      runBlogCycle: async () => {
        await store.mutate((state) => {
          const active = state.jobs.find((item) => item.id === job.id)
          active.leaseOwner = 'worker-new'
        })
        const current = (await store.read()).blogs.find((item) => item.id === blog.id)
        const connector = createConnector({ blog: current, store })
        await connector.createDraft({ id: 'article-stale', title: 'Should not publish', body: 'stale worker' })
        return { workflowId: 'should-not-complete' }
      },
      recordActivity: async () => undefined,
    })

    const result = await scheduler.tick()
    const state = await store.read()
    const active = state.jobs.find((item) => item.id === job.id)

    assert.equal(result.jobs[0].status, 'lease-lost')
    assert.equal(result.jobs[0].retryable, false)
    assert.equal(active.status, 'running')
    assert.equal(active.leaseOwner, 'worker-new')
    assert.equal(state.blogs.find((item) => item.id === blog.id).remotePosts.length, 0)
  })
})
