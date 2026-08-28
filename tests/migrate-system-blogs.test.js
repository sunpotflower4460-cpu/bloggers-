import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateJsonToPostgres } from '../src/migrate-to-postgres.js'
import { JsonStore } from '../src/store.js'
import { mergeSystemSections } from '../src/system-store.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-system-migrate-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function fakeTarget() {
  let document = null
  const system = {}
  const blogs = []
  const jobs = []

  return {
    backend: 'postgres',
    async transaction(mutator) {
      document ??= { version: 5, system: {}, blogs: [], ideas: [], articles: [], approvals: [], activities: [], analytics: [], experiments: [], workflows: [], memories: [], aiUsage: [], jobs: [], locks: [] }
      return mutator(document)
    },
    async systemUpsert(section, value) {
      system[section] = structuredClone(value)
      return structuredClone(value)
    },
    async blogUpsert(blog) {
      const index = blogs.findIndex((item) => item.id === blog.id)
      if (index >= 0) blogs.splice(index, 1)
      blogs.push(structuredClone(blog))
      return structuredClone(blog)
    },
    async jobEnqueue(job) {
      jobs.push(structuredClone(job))
      return structuredClone(job)
    },
    async read() {
      return {
        ...structuredClone(document),
        system: mergeSystemSections(system, {}),
        blogs: structuredClone(blogs),
        jobs: structuredClone(jobs),
        locks: [],
      }
    },
    snapshot() {
      return {
        document: structuredClone(document),
        system: structuredClone(system),
        blogs: structuredClone(blogs),
      }
    },
  }
}

test('JSON migration moves system sections and Blog Brain out of the global PostgreSQL document', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'state.json')
    const source = await new JsonStore(path).init()
    await source.mutate((state) => {
      state.system.paused = true
      state.system.pausedAt = '2026-08-28T10:00:00.000Z'
      state.system.aiBudget = { enabled: true, monthlyUsd: 75, perCycleUsd: 4, reserveUsd: 2 }
      state.system.scheduler = {
        enabled: true,
        intervalMinutes: 90,
        maxRetries: 3,
        retryDelayMinutes: 12,
        lastRunAt: '2026-08-28T09:00:00.000Z',
        nextRunAt: '2026-08-28T10:30:00.000Z',
        running: true,
        retryQueue: [],
      }
      state.blogs.push({
        id: 'blog-native-1',
        name: 'Native Blog',
        slug: 'native-blog',
        active: true,
        connector: { type: 'memory' },
        analytics: {},
        research: {},
        brain: { purpose: 'migration check', audience: '', voice: '', editorialPolicy: '', monetization: '', topics: [] },
        autonomy: { level: 2, allowCreate: true, allowUpdate: true, allowPublish: false, allowDelete: false },
        remotePosts: [],
        createdAt: '2026-08-28T08:00:00.000Z',
        updatedAt: '2026-08-28T08:00:00.000Z',
      })
    })

    const target = fakeTarget()
    const result = await migrateJsonToPostgres({ sourcePath: path, targetStore: target })
    const migrated = await target.read()
    const snapshot = target.snapshot()

    assert.equal(result.migratedSystemSections, 3)
    assert.equal(result.systemKeptInStateDocument, 0)
    assert.equal(result.migratedBlogs, 1)
    assert.equal(result.blogsKeptInStateDocument, 0)
    assert.deepEqual(snapshot.document.system, {})
    assert.deepEqual(snapshot.document.blogs, [])
    assert.deepEqual(Object.keys(snapshot.system).sort(), ['aiBudget', 'core', 'scheduler'])
    assert.equal(snapshot.system.core.paused, true)
    assert.equal(snapshot.system.aiBudget.monthlyUsd, 75)
    assert.equal(snapshot.system.scheduler.enabled, true)
    assert.equal(snapshot.system.scheduler.running, false)
    assert.equal(migrated.system.paused, true)
    assert.equal(migrated.system.scheduler.intervalMinutes, 90)
    assert.equal(migrated.system.scheduler.running, false)
    assert.equal(migrated.blogs.length, 1)
    assert.equal(migrated.blogs[0].id, 'blog-native-1')
  })
})
