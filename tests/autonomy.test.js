import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startExperiment, evaluateExperiments } from '../src/experiments.js'
import { buildPortfolioPlan } from '../src/portfolio.js'
import { configureScheduler, createScheduler } from '../src/scheduler.js'
import { JsonStore } from '../src/store.js'
import { addBlog } from '../src/orchestrator.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-autonomy-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('Portfolio Brain prioritizes stronger measured growth', async () => {
  await withStore(async (store) => {
    const first = await addBlog(store, { name: 'Growing', connector: { type: 'memory' } })
    const second = await addBlog(store, { name: 'Flat', connector: { type: 'memory' } })
    await store.mutate((state) => {
      state.analytics.unshift(
        { id: 'm4', blogId: second.id, capturedAt: '2026-08-28T04:00:00Z', clicks: 100 },
        { id: 'm3', blogId: second.id, capturedAt: '2026-08-27T04:00:00Z', clicks: 100 },
        { id: 'm2', blogId: first.id, capturedAt: '2026-08-28T03:00:00Z', clicks: 140 },
        { id: 'm1', blogId: first.id, capturedAt: '2026-08-27T03:00:00Z', clicks: 100 },
      )
    })
    const plan = buildPortfolioPlan(await store.read())
    assert.equal(plan.ranking[0].blogId, first.id)
    assert.equal(plan.ranking[0].growthPct, 40)
  })
})

test('Experiment Engine promotes a measured result into Blog Memory', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, { name: 'Learning Blog', connector: { type: 'memory' } })
    const experiment = await startExperiment(store, {
      blog,
      decision: { action: 'CREATE', rationale: '入口記事で検索流入を増やす' },
      snapshot: { clicks: 100 },
      ideaId: 'idea_1',
      articleId: 'article_1',
    })
    assert.equal(experiment.targetMetric, 'clicks')

    await evaluateExperiments(store, blog.id, { clicks: 108 })
    await evaluateExperiments(store, blog.id, { clicks: 115 })
    const result = await evaluateExperiments(store, blog.id, { clicks: 120 })
    const state = await store.read()

    assert.equal(result.completed.length, 1)
    assert.equal(result.completed[0].result, 'positive')
    assert.ok(state.memories.some((item) => item.sourceExperimentId === experiment.id))
  })
})

test('Scheduler runs a due portfolio cycle and advances nextRunAt', async () => {
  await withStore(async (store) => {
    await configureScheduler(store, { enabled: true, intervalMinutes: 15, maxRetries: 2, retryDelayMinutes: 1 })
    await store.mutate((state) => {
      state.system.scheduler.nextRunAt = '2026-08-28T00:00:00.000Z'
    })

    let calls = 0
    const scheduler = createScheduler({
      store,
      clock: () => Date.parse('2026-08-28T01:00:00.000Z'),
      runPortfolioCycle: async () => {
        calls += 1
        return { skipped: false, results: [] }
      },
      runBlogCycle: async () => ({ skipped: false }),
      recordActivity: async () => undefined,
    })

    const result = await scheduler.tick()
    const state = await store.read()
    assert.equal(result.skipped, false)
    assert.equal(calls, 1)
    assert.ok(state.system.scheduler.lastRunAt)
    assert.ok(new Date(state.system.scheduler.nextRunAt).getTime() > Date.parse('2026-08-28T01:00:00.000Z'))
  })
})

test('Scheduler does not enqueue retries for monthly budget reserve failures', async () => {
  await withStore(async (store) => {
    await configureScheduler(store, { enabled: true, intervalMinutes: 15, maxRetries: 2, retryDelayMinutes: 1 })
    await store.mutate((state) => {
      state.system.scheduler.nextRunAt = '2026-08-28T00:00:00.000Z'
    })

    const scheduler = createScheduler({
      store,
      clock: () => Date.parse('2026-08-28T01:00:00.000Z'),
      runPortfolioCycle: async () => ({
        skipped: false,
        results: [{
          blogId: 'budget-blog',
          ok: false,
          error: 'AI monthly budget reserve reached. spent=$9.9000 budget=$10.00',
        }],
      }),
      runBlogCycle: async () => ({ skipped: false }),
      recordActivity: async () => undefined,
    })

    const result = await scheduler.tick()
    const state = await store.read()
    assert.equal(result.skipped, false)
    assert.equal(state.jobs.filter((item) => item.type === 'blog-cycle').length, 0)
    const portfolioJob = state.jobs.find((item) => item.type === 'portfolio-cycle')
    assert.equal(portfolioJob.status, 'completed')
    assert.deepEqual(portfolioJob.result.nonRetryableBlogs, ['budget-blog'])
  })
})
