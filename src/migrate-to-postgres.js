// @feature F-007
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
  const sourceJobs = structuredClone(sourceState.jobs ?? [])
  const sourceAnalytics = structuredClone(sourceState.analytics ?? [])
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

  const nativeAnalytics = typeof target.analyticsAppend === 'function'
  if (nativeAnalytics) portableState.analytics = []

  await target.transaction((state) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, structuredClone(portableState))
  })

  let migratedAnalytics = 0
  if (nativeAnalytics) {
    for (const snapshot of sourceAnalytics) {
      await target.analyticsAppend(snapshot, { limit: 5000 })
      migratedAnalytics += 1
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
    blogs: portableState.blogs?.length ?? 0,
    articles: portableState.articles?.length ?? 0,
    migratedAnalytics,
    analyticsKeptInStateDocument: nativeAnalytics ? 0 : sourceAnalytics.length,
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
