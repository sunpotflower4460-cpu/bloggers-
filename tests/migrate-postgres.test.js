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
  const nativeAnalytics = []
  const nativeActivities = []
  const nativeAiUsage = []
  const nativeWorkflows = []
  const nativeIdeas = []
  return {
    backend: 'postgres',
    async transaction(mutator) {
      document ??= { system: {}, blogs: [], ideas: [], analytics: [], activities: [], aiUsage: [], workflows: [], jobs: [], locks: [] }
      return mutator(document)
    },
    async read() {
      return {
        ...structuredClone(document),
        ideas: structuredClone(nativeIdeas),
        analytics: structuredClone(nativeAnalytics),
        activities: structuredClone(nativeActivities),
        aiUsage: structuredClone(nativeAiUsage),
        workflows: structuredClone(nativeWorkflows),
        jobs: structuredClone(nativeJobs),
        locks: [],
      }
    },
    async analyticsAppend(snapshot) {
      const index = nativeAnalytics.findIndex((item) => item.id === snapshot.id)
      if (index >= 0) nativeAnalytics.splice(index, 1)
      nativeAnalytics.unshift(structuredClone(snapshot))
      return structuredClone(snapshot)
    },
    async activityAppend(activity) {
      const index = nativeActivities.findIndex((item) => item.id === activity.id)
      if (index >= 0) nativeActivities.splice(index, 1)
      nativeActivities.unshift(structuredClone(activity))
      return structuredClone(activity)
    },
    async aiUsageAppend(entries) {
      for (const usage of entries) {
        const index = nativeAiUsage.findIndex((item) => item.id === usage.id)
        if (index >= 0) nativeAiUsage.splice(index, 1)
        nativeAiUsage.unshift(structuredClone(usage))
      }
      return entries.map((item) => structuredClone(item))
    },
    async workflowUpsert(workflow) {
      const index = nativeWorkflows.findIndex((item) => item.id === workflow.id)
      if (index >= 0) nativeWorkflows.splice(index, 1)
      nativeWorkflows.unshift(structuredClone(workflow))
      return structuredClone(workflow)
    },
    async ideaAppend(idea) {
      const index = nativeIdeas.findIndex((item) => item.id === idea.id)
      if (index >= 0) nativeIdeas.splice(index, 1)
      nativeIdeas.unshift(structuredClone(idea))
      return structuredClone(idea)
    },
    async jobEnqueue(job, dedupeKey) {
      const existing = nativeJobs.find((item) => item.id === job.id || (dedupeKey && ['queued', 'running'].includes(item.status) && item.payload?.dedupeKey === dedupeKey))
      if (existing) return structuredClone(existing)
      const saved = structuredClone(job)
      if (dedupeKey) saved.payload = { ...(saved.payload ?? {}), dedupeKey }
      nativeJobs.push(saved)
      return structuredClone(saved)
    },
    stateDocument() {
      return structuredClone(document)
    },
  }
}

test('JSON to PostgreSQL migration promotes normalized collections, recovers running jobs, and discards old operation leases', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'state.json')
    const source = await new JsonStore(path).init()
    await source.mutate((state) => {
      state.blogs.push({ id: 'blog_1', name: 'Migrated Blog' })
      state.articles.push({ id: 'article_1', blogId: 'blog_1', title: 'Hello' })
      state.ideas.push({
        id: 'idea_1',
        blogId: 'blog_1',
        action: 'CREATE',
        topic: 'migration',
        title: 'Migration idea',
        rationale: 'verify native idea migration',
        confidence: 0.8,
        status: 'proposed',
        createdAt: '2026-08-28T00:01:30.000Z',
      })
      state.analytics.push({
        id: 'metric_1',
        blogId: 'blog_1',
        capturedAt: '2026-08-28T00:02:00.000Z',
        clicks: 42,
        source: 'search-console',
      })
      state.activities.push({
        id: 'activity_1',
        blogId: 'blog_1',
        createdAt: '2026-08-28T00:03:00.000Z',
        agent: 'observer',
        type: 'cycle.observe',
        message: 'observed',
      })
      state.aiUsage.push({
        id: 'usage_1',
        blogId: 'blog_1',
        workflowId: 'workflow_1',
        createdAt: '2026-08-28T00:04:00.000Z',
        operation: 'decide',
        provider: 'test',
        model: 'model-a',
        inputTokens: 100,
        outputTokens: 20,
        estimatedCostUsd: 0.01,
      })
      state.workflows.push({
        id: 'workflow_1',
        blogId: 'blog_1',
        trigger: 'scheduler',
        status: 'completed',
        startedAt: '2026-08-28T00:01:00.000Z',
        finishedAt: '2026-08-28T00:05:00.000Z',
        aiCostUsd: 0.01,
      })
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
    const document = target.stateDocument()

    assert.equal(result.blogs, 1)
    assert.equal(result.articles, 1)
    assert.equal(result.migratedIdeas, 1)
    assert.equal(result.ideasKeptInStateDocument, 0)
    assert.equal(result.migratedAnalytics, 1)
    assert.equal(result.analyticsKeptInStateDocument, 0)
    assert.equal(result.migratedActivities, 1)
    assert.equal(result.activitiesKeptInStateDocument, 0)
    assert.equal(result.migratedAiUsage, 1)
    assert.equal(result.aiUsageKeptInStateDocument, 0)
    assert.equal(result.migratedWorkflows, 1)
    assert.equal(result.workflowsKeptInStateDocument, 0)
    assert.equal(result.migratedJobs, 2)
    assert.equal(result.recoveredRunningJobs, 1)
    assert.equal(result.discardedOperationLeases, 1)
    assert.equal(migrated.system.scheduler.running, false)
    assert.equal(migrated.locks.length, 0)
    assert.equal(document.ideas.length, 0, 'normalized ideas should not remain in the global state document')
    assert.equal(document.analytics.length, 0, 'normalized analytics should not remain in the global state document')
    assert.equal(document.activities.length, 0, 'normalized activities should not remain in the global state document')
    assert.equal(document.aiUsage.length, 0, 'normalized AI usage should not remain in the global state document')
    assert.equal(document.workflows.length, 0, 'normalized workflows should not remain in the global state document')
    assert.equal(migrated.ideas.length, 1)
    assert.equal(migrated.ideas[0].id, 'idea_1')
    assert.equal(migrated.ideas[0].title, 'Migration idea')
    assert.equal(migrated.analytics.length, 1)
    assert.equal(migrated.analytics[0].id, 'metric_1')
    assert.equal(migrated.analytics[0].clicks, 42)
    assert.equal(migrated.activities.length, 1)
    assert.equal(migrated.activities[0].id, 'activity_1')
    assert.equal(migrated.activities[0].message, 'observed')
    assert.equal(migrated.aiUsage.length, 1)
    assert.equal(migrated.aiUsage[0].id, 'usage_1')
    assert.equal(migrated.aiUsage[0].estimatedCostUsd, 0.01)
    assert.equal(migrated.workflows.length, 1)
    assert.equal(migrated.workflows[0].id, 'workflow_1')
    assert.equal(migrated.workflows[0].status, 'completed')

    const recovered = migrated.jobs.find((job) => job.id === 'job_running')
    assert.equal(recovered.status, 'queued')
    assert.equal(recovered.leaseOwner, null)
    assert.equal(recovered.leaseUntil, null)

    const completed = migrated.jobs.find((job) => job.id === 'job_done')
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.result, { ok: true })
  })
})
