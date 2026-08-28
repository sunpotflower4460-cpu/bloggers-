// @feature F-002
// @feature F-004
// @feature F-005
// @feature F-006
// @feature F-007
// @feature F-009
// @feature F-011
// @feature F-012
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStore } from './storage.js'
import { JsonStore } from './store.js'

function resetJobForMigration(job) {
  const migrated = structuredClone(job)
  if (migrated.status === 'running') {
    migrated.status = 'queued'
    migrated.leaseUntil = null
    migrated.leasedAt = null
    migrated.leaseOwner = null
    migrated.finishedAt = null
    migrated.updatedAt = new Date().toISOString()
  }
  return migrated
}

export async function migrateJsonToPostgres({
  sourcePath = process.env.BLOGGERS_MIGRATION_JSON_FILE || process.env.BLOGGERS_DATA_FILE || './data/state.json',
  env = process.env,
  targetStore = null,
} = {}) {
  const absoluteSource = resolve(sourcePath)
  await access(absoluteSource)

  const source = await new JsonStore(absoluteSource).init()
  const sourceState = await source.read()
  const sourceBlogs = structuredClone(sourceState.blogs ?? [])
  const sourceJobs = structuredClone(sourceState.jobs ?? [])
  const sourceAnalytics = structuredClone(sourceState.analytics ?? [])
  const sourceActivities = structuredClone(sourceState.activities ?? [])
  const sourceAiUsage = structuredClone(sourceState.aiUsage ?? [])
  const sourceWorkflows = structuredClone(sourceState.workflows ?? [])
  const sourceIdeas = structuredClone(sourceState.ideas ?? [])
  const sourceArticles = structuredClone(sourceState.articles ?? [])
  const sourceApprovals = structuredClone(sourceState.approvals ?? [])
  const sourceExperiments = structuredClone(sourceState.experiments ?? [])
  const sourceMemories = structuredClone(sourceState.memories ?? [])
  const portableState = structuredClone(sourceState)
  portableState.jobs = []
  portableState.locks = []
  portableState.system ??= {}
  portableState.system.scheduler ??= {}
  portableState.system.scheduler.running = false

  const target = targetStore ?? await createStore({
    env: { ...env, BLOGGERS_STORAGE_DRIVER: 'postgres' },
  })
  if (target.backend !== 'postgres') throw new Error('Migration target must be PostgreSQL')
  if (typeof target.jobEnqueue !== 'function') throw new Error('Migration target does not support native PostgreSQL jobs')

  const nativeBlogs = typeof target.blogUpsert === 'function'
  const nativeAnalytics = typeof target.analyticsAppend === 'function'
  const nativeActivities = typeof target.activityAppend === 'function'
  const nativeAiUsage = typeof target.aiUsageAppend === 'function'
  const nativeWorkflows = typeof target.workflowUpsert === 'function'
  const nativeIdeas = typeof target.ideaAppend === 'function'
  const nativeArticles = typeof target.articleUpsert === 'function'
  const nativeApprovals = typeof target.approvalUpsert === 'function'
  const nativeExperiments = typeof target.experimentUpsert === 'function'
  const nativeMemories = typeof target.memoryUpsert === 'function'
  if (nativeBlogs) portableState.blogs = []
  if (nativeAnalytics) portableState.analytics = []
  if (nativeActivities) portableState.activities = []
  if (nativeAiUsage) portableState.aiUsage = []
  if (nativeWorkflows) portableState.workflows = []
  if (nativeIdeas) portableState.ideas = []
  if (nativeArticles) portableState.articles = []
  if (nativeApprovals) portableState.approvals = []
  if (nativeExperiments) portableState.experiments = []
  if (nativeMemories) portableState.memories = []

  await target.transaction((state) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, structuredClone(portableState))
  })

  let migratedBlogs = 0
  if (nativeBlogs) {
    for (const blog of sourceBlogs) {
      await target.blogUpsert(blog)
      migratedBlogs += 1
    }
  }

  let migratedAnalytics = 0
  if (nativeAnalytics) {
    for (const snapshot of sourceAnalytics) {
      await target.analyticsAppend(snapshot, { limit: 5000 })
      migratedAnalytics += 1
    }
  }

  let migratedActivities = 0
  if (nativeActivities) {
    for (const activity of sourceActivities) {
      await target.activityAppend(activity, { limit: 1000 })
      migratedActivities += 1
    }
  }

  let migratedAiUsage = 0
  if (nativeAiUsage && sourceAiUsage.length > 0) {
    await target.aiUsageAppend(sourceAiUsage, { limit: 10_000 })
    migratedAiUsage = sourceAiUsage.length
  }

  let migratedWorkflows = 0
  if (nativeWorkflows) {
    for (const workflow of sourceWorkflows) {
      await target.workflowUpsert(workflow, { limit: 2000 })
      migratedWorkflows += 1
    }
  }

  let migratedIdeas = 0
  if (nativeIdeas) {
    for (const idea of sourceIdeas) {
      await target.ideaAppend(idea, { limit: 3000 })
      migratedIdeas += 1
    }
  }

  let migratedArticles = 0
  if (nativeArticles) {
    for (const article of sourceArticles) {
      await target.articleUpsert(article, { limit: 5000 })
      migratedArticles += 1
    }
  }

  let migratedApprovals = 0
  if (nativeApprovals) {
    for (const approval of sourceApprovals) {
      await target.approvalUpsert(approval, { limit: 3000 })
      migratedApprovals += 1
    }
  }

  let migratedExperiments = 0
  if (nativeExperiments) {
    for (const experiment of sourceExperiments) {
      await target.experimentUpsert(experiment)
      migratedExperiments += 1
    }
  }

  let migratedMemories = 0
  if (nativeMemories) {
    for (const memory of sourceMemories) {
      await target.memoryUpsert(memory)
      migratedMemories += 1
    }
  }

  const existing = await target.read()
  const existingJobIds = new Set((existing.jobs ?? []).map((job) => job.id))
  let migratedJobs = 0
  let skippedJobs = 0
  let recoveredRunningJobs = 0

  for (const original of sourceJobs) {
    if (existingJobIds.has(original.id)) {
      skippedJobs += 1
      continue
    }
    const job = resetJobForMigration(original)
    if (original.status === 'running') recoveredRunningJobs += 1
    await target.jobEnqueue(job, job.payload?.dedupeKey ?? null)
    existingJobIds.add(job.id)
    migratedJobs += 1
  }

  return {
    source: absoluteSource,
    blogs: sourceBlogs.length,
    articles: sourceArticles.length,
    approvals: sourceApprovals.length,
    experiments: sourceExperiments.length,
    memories: sourceMemories.length,
    migratedBlogs,
    blogsKeptInStateDocument: nativeBlogs ? 0 : sourceBlogs.length,
    migratedAnalytics,
    analyticsKeptInStateDocument: nativeAnalytics ? 0 : sourceAnalytics.length,
    migratedActivities,
    activitiesKeptInStateDocument: nativeActivities ? 0 : sourceActivities.length,
    migratedAiUsage,
    aiUsageKeptInStateDocument: nativeAiUsage ? 0 : sourceAiUsage.length,
    migratedWorkflows,
    workflowsKeptInStateDocument: nativeWorkflows ? 0 : sourceWorkflows.length,
    migratedIdeas,
    ideasKeptInStateDocument: nativeIdeas ? 0 : sourceIdeas.length,
    migratedArticles,
    articlesKeptInStateDocument: nativeArticles ? 0 : sourceArticles.length,
    migratedApprovals,
    approvalsKeptInStateDocument: nativeApprovals ? 0 : sourceApprovals.length,
    migratedExperiments,
    experimentsKeptInStateDocument: nativeExperiments ? 0 : sourceExperiments.length,
    migratedMemories,
    memoriesKeptInStateDocument: nativeMemories ? 0 : sourceMemories.length,
    migratedJobs,
    skippedJobs,
    recoveredRunningJobs,
    discardedOperationLeases: sourceState.locks?.length ?? 0,
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  migrateJsonToPostgres()
    .then((result) => {
      console.log(`Bloggers migration complete: ${JSON.stringify(result)}`)
    })
    .catch((error) => {
      console.error(`Bloggers migration failed: ${error.message}`)
      process.exitCode = 1
    })
}
