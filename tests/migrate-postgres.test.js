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
  const nativeBlogs = []
  const nativeJobs = []
  const nativeAnalytics = []
  const nativeActivities = []
  const nativeAiUsage = []
  const nativeWorkflows = []
  const nativeIdeas = []
  const nativeArticles = []
  const nativeApprovals = []
  const nativeExperiments = []
  const nativeMemories = []
  return {
    backend: 'postgres',
    async transaction(mutator) {
      document ??= { system: {}, blogs: [], ideas: [], articles: [], approvals: [], analytics: [], activities: [], aiUsage: [], workflows: [], experiments: [], memories: [], jobs: [], locks: [] }
      return mutator(document)
    },
    async read() {
      return {
        ...structuredClone(document),
        blogs: structuredClone(nativeBlogs),
        ideas: structuredClone(nativeIdeas),
        articles: structuredClone(nativeArticles),
        approvals: structuredClone(nativeApprovals),
        analytics: structuredClone(nativeAnalytics),
        activities: structuredClone(nativeActivities),
        aiUsage: structuredClone(nativeAiUsage),
        workflows: structuredClone(nativeWorkflows),
        experiments: structuredClone(nativeExperiments),
        memories: structuredClone(nativeMemories),
        jobs: structuredClone(nativeJobs),
        locks: [],
      }
    },
    async blogUpsert(blog) {
      const index = nativeBlogs.findIndex((item) => item.id === blog.id)
      if (index >= 0) nativeBlogs.splice(index, 1)
      nativeBlogs.push(structuredClone(blog))
      return structuredClone(blog)
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
    async articleUpsert(article) {
      const index = nativeArticles.findIndex((item) => item.id === article.id)
      if (index >= 0) nativeArticles.splice(index, 1)
      nativeArticles.unshift(structuredClone(article))
      return structuredClone(article)
    },
    async approvalUpsert(approval) {
      const index = nativeApprovals.findIndex((item) => item.id === approval.id)
      if (index >= 0) nativeApprovals.splice(index, 1)
      nativeApprovals.unshift(structuredClone(approval))
      return structuredClone(approval)
    },
    async experimentUpsert(experiment) {
      const index = nativeExperiments.findIndex((item) => item.id === experiment.id)
      if (index >= 0) nativeExperiments.splice(index, 1)
      nativeExperiments.unshift(structuredClone(experiment))
      return structuredClone(experiment)
    },
    async memoryUpsert(memory) {
      const index = nativeMemories.findIndex((item) => item.id === memory.id)
      if (index >= 0) nativeMemories.splice(index, 1)
      nativeMemories.unshift(structuredClone(memory))
      return structuredClone(memory)
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
      state.blogs.push({
        id: 'blog_1',
        name: 'Migrated Blog',
        slug: 'migrated-blog',
        active: true,
        connector: { type: 'memory' },
        brain: { purpose: 'migration' },
        remotePosts: [],
        createdAt: '2026-08-28T00:01:00.000Z',
        updatedAt: '2026-08-28T00:01:00.000Z',
      })
      state.articles.push({
        id: 'article_1',
        blogId: 'blog_1',
        ideaId: 'idea_1',
        title: 'Hello',
        status: 'draft',
        createdAt: '2026-08-28T00:01:40.000Z',
        updatedAt: '2026-08-28T00:01:40.000Z',
      })
      state.approvals.push({
        id: 'approval_1',
        blogId: 'blog_1',
        articleId: 'article_1',
        action: 'PUBLISH',
        reason: 'review',
        status: 'pending',
        createdAt: '2026-08-28T00:01:50.000Z',
        resolvedAt: null,
      })
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
      state.experiments.push({
        id: 'experiment_1',
        blogId: 'blog_1',
        articleId: 'article_1',
        action: 'CREATE',
        hypothesis: 'migration experiment',
        targetMetric: 'clicks',
        baselineValue: 40,
        latestValue: 42,
        deltaPct: 5,
        observations: 3,
        status: 'completed',
        result: 'positive',
        confidence: 0.6,
        createdAt: '2026-08-28T00:01:55.000Z',
        completedAt: '2026-08-28T00:04:00.000Z',
      })
      state.memories.push({
        id: 'memory_1',
        scope: 'blog',
        blogId: 'blog_1',
        type: 'experiment-learning',
        createdAt: '2026-08-28T00:04:01.000Z',
        confidence: 0.6,
        text: 'migration learning',
        sourceExperimentId: 'experiment_1',
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
    assert.equal(result.approvals, 1)
    assert.equal(result.experiments, 1)
    assert.equal(result.memories, 1)
    assert.equal(result.migratedBlogs, 1)
    assert.equal(result.blogsKeptInStateDocument, 0)
    assert.equal(result.migratedIdeas, 1)
    assert.equal(result.ideasKeptInStateDocument, 0)
    assert.equal(result.migratedArticles, 1)
    assert.equal(result.articlesKeptInStateDocument, 0)
    assert.equal(result.migratedApprovals, 1)
    assert.equal(result.approvalsKeptInStateDocument, 0)
    assert.equal(result.migratedExperiments, 1)
    assert.equal(result.experimentsKeptInStateDocument, 0)
    assert.equal(result.migratedMemories, 1)
    assert.equal(result.memoriesKeptInStateDocument, 0)
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
    assert.equal(document.blogs.length, 0)
    assert.equal(document.ideas.length, 0)
    assert.equal(document.articles.length, 0)
    assert.equal(document.approvals.length, 0)
    assert.equal(document.experiments.length, 0)
    assert.equal(document.memories.length, 0)
    assert.equal(document.analytics.length, 0)
    assert.equal(document.activities.length, 0)
    assert.equal(document.aiUsage.length, 0)
    assert.equal(document.workflows.length, 0)
    assert.equal(migrated.blogs[0].id, 'blog_1')
    assert.equal(migrated.blogs[0].slug, 'migrated-blog')
    assert.equal(migrated.blogs[0].brain.purpose, 'migration')
    assert.equal(migrated.ideas[0].id, 'idea_1')
    assert.equal(migrated.articles[0].id, 'article_1')
    assert.equal(migrated.articles[0].status, 'draft')
    assert.equal(migrated.approvals[0].id, 'approval_1')
    assert.equal(migrated.approvals[0].status, 'pending')
    assert.equal(migrated.experiments[0].id, 'experiment_1')
    assert.equal(migrated.experiments[0].result, 'positive')
    assert.equal(migrated.memories[0].id, 'memory_1')
    assert.equal(migrated.memories[0].sourceExperimentId, 'experiment_1')
    assert.equal(migrated.analytics[0].clicks, 42)
    assert.equal(migrated.activities[0].message, 'observed')
    assert.equal(migrated.aiUsage[0].estimatedCostUsd, 0.01)
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
