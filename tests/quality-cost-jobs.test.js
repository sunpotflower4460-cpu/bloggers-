import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiBudgetReserveReachedError, budgetStatus, recordAiUsage } from '../src/cost.js'
import { enqueueJob, leaseDueJobs } from '../src/jobs.js'
import { addBlog, runBlogCycle } from '../src/orchestrator.js'
import { assertPublicHttpUrl, buildInternalLinkCandidates, evaluateContentQuality } from '../src/quality.js'
import { JsonStore } from '../src/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-quality-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('citation quality gate blocks required missing and unknown sources', () => {
  const missing = evaluateContentQuality({
    body: '# Draft\nA factual claim.',
    research: { requireCitations: true },
    sources: [],
  })
  assert.equal(missing.ok, false)
  assert.match(missing.blocking[0], /出典必須/)

  const unknown = evaluateContentQuality({
    body: 'Claim [S9]',
    research: { requireCitations: true },
    sources: [{ id: 'S1', label: 'Primary', url: 'https://example.com' }],
  })
  assert.equal(unknown.ok, false)
  assert.match(unknown.blocking[0], /S9/)
})

test('private research endpoints are rejected before fetch', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1/private'), /Private-network/)
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/private'), /Local research/)
})

test('internal link candidates prefer related posts and exclude the article being revised', () => {
  const posts = [
    { id: 1, title: '録音の基本', content: 'マイクと録音', link: 'https://example.com/recording' },
    { id: 2, title: '録音マイク比較', content: '録音向けマイク', link: 'https://example.com/microphones' },
    { id: 3, title: '旅行記', content: '海へ行く', link: 'https://example.com/travel' },
  ]
  const createLinks = buildInternalLinkCandidates(posts, { action: 'CREATE', topic: '録音', title: '録音を始める' })
  assert.deepEqual(createLinks.map((item) => item.id), [1, 2])

  const updateLinks = buildInternalLinkCandidates(posts, { action: 'UPDATE', targetPostId: 1, topic: '録音', title: '録音の基本' })
  assert.deepEqual(updateLinks.map((item) => item.id), [2])
})

test('autopublish is downgraded to human approval when citations are required but unavailable', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Citation Blog',
      brain: { purpose: '検証', topics: ['一次情報'] },
      connector: { type: 'memory' },
      research: { requireCitations: true, sources: [] },
      autonomy: { level: 4, allowCreate: true, allowPublish: true },
    })
    const result = await runBlogCycle(store, blog.id)
    const state = await store.read()
    assert.equal(result.article.quality.ok, false)
    assert.equal(result.published, null)
    assert.equal(result.approval.action, 'PUBLISH')
    assert.match(result.approval.reason, /品質ゲート/)
    assert.equal(state.articles[0].status, 'draft')
  })
})

test('AI cost governor records usage and stops extra generation after per-cycle limit', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Budget Blog',
      brain: { topics: ['AI'] },
      connector: { type: 'memory' },
      autonomy: { level: 2 },
    })
    await store.mutate((state) => {
      state.system.aiBudget = { enabled: true, monthlyUsd: 10, perCycleUsd: 0.01, reserveUsd: 0 }
    })

    const usage = []
    const provider = {
      name: 'openai-compatible:test',
      async decide() {
        usage.push({ operation: 'decide', provider: this.name, model: 'director', inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.02 })
        return { action: 'CREATE', topic: 'AI', title: 'AI入門', rationale: 'test', confidence: 0.8 }
      },
      async draft() {
        throw new Error('draft should not be called after the per-cycle limit is reached')
      },
      drainUsage() {
        return usage.splice(0)
      },
    }

    const result = await runBlogCycle(store, blog.id, { provider })
    const state = await store.read()
    assert.equal(result.budgetExceeded, true)
    assert.equal(result.article, null)
    assert.equal(state.aiUsage.length, 1)
    assert.equal(budgetStatus(state).usage.totalUsd, 0.02)
  })
})

test('monthly reserve is enforced immediately after the call that crosses it', async () => {
  await withStore(async (store) => {
    await store.mutate((state) => {
      state.system.aiBudget = { enabled: true, monthlyUsd: 1, perCycleUsd: 1, reserveUsd: 0.1 }
      state.aiUsage = [{
        id: 'usage_existing',
        createdAt: new Date().toISOString(),
        estimatedCostUsd: 0.88,
        inputTokens: 1,
        outputTokens: 1,
      }]
    })

    await assert.rejects(
      () => recordAiUsage(store, [{
        operation: 'decide',
        provider: 'test',
        model: 'director',
        estimatedCostUsd: 0.03,
      }]),
      (error) => error instanceof AiBudgetReserveReachedError && error.code === 'AI_BUDGET_RESERVE_REACHED',
    )

    const state = await store.read()
    const status = budgetStatus(state)
    assert.equal(Number(status.usage.totalUsd.toFixed(2)), 0.91)
    assert.equal(status.blocked, true)
  })
})

test('expired running jobs are reclaimed by a new lease', async () => {
  await withStore(async (store) => {
    const now = Date.parse('2026-08-28T03:00:00.000Z')
    const job = await enqueueJob(store, { type: 'blog-cycle', blogId: 'b1', dueAt: '2026-08-28T01:00:00.000Z' })
    const first = await leaseDueJobs(store, { now, leaseMs: 1000 })
    assert.equal(first[0].id, job.id)
    assert.equal(first[0].attempt, 1)

    const reclaimed = await leaseDueJobs(store, { now: now + 2000, leaseMs: 1000 })
    assert.equal(reclaimed[0].id, job.id)
    assert.equal(reclaimed[0].attempt, 2)
  })
})
