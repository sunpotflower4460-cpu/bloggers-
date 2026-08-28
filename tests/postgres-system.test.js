import test from 'node:test'
import assert from 'node:assert/strict'
import { PostgresSystemStore } from '../src/postgres-system-store.js'
import { mutateSystemSection } from '../src/system-store.js'
import {
  configureAiBudgetVersioned,
  configureSchedulerVersioned,
  settingsVersions,
} from '../src/settings-control.js'

function fakePool({ legacySystem = {} } = {}) {
  let stateDocument = {
    version: 5,
    system: structuredClone(legacySystem),
    blogs: [],
    ideas: [],
    articles: [],
    approvals: [],
    activities: [],
    analytics: [],
    experiments: [],
    workflows: [],
    memories: [],
    aiUsage: [],
    jobs: [],
    locks: [],
  }
  let stateVersion = 5
  const system = new Map()
  const queries = []

  function settingRow(key) {
    const item = system.get(key)
    if (!item) return null
    return {
      setting_key: key,
      document: structuredClone(item.document),
      revision: item.revision,
      updated_at: item.updatedAt,
    }
  }

  function insertSetting(params, text) {
    const [key, raw] = params
    const document = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
    const existing = system.get(key)
    if (!existing) {
      system.set(key, { document, revision: 1, updatedAt: '2026-08-28T00:00:00.000Z' })
    } else if (/DO UPDATE SET/.test(text)) {
      system.set(key, { document, revision: existing.revision + 1, updatedAt: '2026-08-28T00:00:01.000Z' })
    }
  }

  async function query(sql, params = []) {
    const text = String(sql)
    queries.push({ text, params: structuredClone(params) })

    if (/SELECT document, version FROM bloggers_state WHERE state_key = \$1 FOR UPDATE/.test(text)) {
      return { rows: [{ document: structuredClone(stateDocument), version: stateVersion }] }
    }
    if (/SELECT document FROM bloggers_state WHERE state_key = \$1 FOR UPDATE/.test(text)) {
      return { rows: [{ document: structuredClone(stateDocument) }] }
    }
    if (/UPDATE bloggers_state\s+SET document = \$2::jsonb/.test(text)) {
      stateDocument = typeof params[1] === 'string' ? JSON.parse(params[1]) : structuredClone(params[1])
      stateVersion = Number(params[2] ?? stateVersion)
      return { rows: [] }
    }
    if (/SELECT document FROM bloggers_state WHERE state_key = \$1/.test(text)) {
      return { rows: [{ document: structuredClone(stateDocument) }] }
    }

    if (/INSERT INTO bloggers_system_settings/.test(text)) {
      insertSetting(params, text)
      return { rows: [] }
    }
    if (/SELECT setting_key, document, revision, updated_at\s+FROM bloggers_system_settings/.test(text)) {
      const rows = [...system.keys()].sort().map(settingRow)
      return { rows }
    }
    if (/SELECT document, revision, updated_at\s+FROM bloggers_system_settings\s+WHERE setting_key = \$1/.test(text)) {
      const row = settingRow(params[0])
      return { rows: row ? [row] : [] }
    }
    if (/SELECT document, revision\s+FROM bloggers_system_settings\s+WHERE setting_key = \$1\s+FOR UPDATE/.test(text)) {
      const row = settingRow(params[0])
      return { rows: row ? [row] : [] }
    }
    if (/UPDATE bloggers_system_settings\s+SET document = \$2::jsonb/.test(text)) {
      const [key, raw] = params
      const current = system.get(key) ?? { revision: 0 }
      system.set(key, {
        document: typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw),
        revision: current.revision + 1,
        updatedAt: '2026-08-28T00:00:02.000Z',
      })
      return { rows: [] }
    }

    if (/SELECT pg_advisory_xact_lock/.test(text)) return { rows: [] }
    if (/SELECT id, slug, active, created_at, updated_at, document\s+FROM bloggers_blogs/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_ideas/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, idea_id, status, created_at, updated_at, document\s+FROM bloggers_articles/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, article_id, status, created_at, resolved_at, document\s+FROM bloggers_approvals/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, article_id, action, status, created_at, completed_at, document\s+FROM bloggers_experiments/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, scope, type, source_experiment_id, created_at, document\s+FROM bloggers_memories/.test(text)) return { rows: [] }
    if (/FROM bloggers_jobs/.test(text) || /FROM bloggers_operation_leases/.test(text)) return { rows: [] }
    if (/FROM bloggers_analytics/.test(text) || /FROM bloggers_activities/.test(text)) return { rows: [] }
    if (/FROM bloggers_ai_usage/.test(text) || /FROM bloggers_workflows/.test(text)) return { rows: [] }
    if (/DELETE FROM bloggers_/.test(text)) return { rows: [] }
    return { rows: [] }
  }

  const client = { query, release() {} }
  return {
    async connect() { return client },
    query,
    snapshot() {
      return {
        stateDocument: structuredClone(stateDocument),
        stateVersion,
        system: Object.fromEntries([...system.entries()].map(([key, value]) => [key, structuredClone(value)])),
        queries: structuredClone(queries),
      }
    },
  }
}

test('PostgresSystemStore promotes legacy system state into core, aiBudget and scheduler rows', async () => {
  const pool = fakePool({
    legacySystem: {
      paused: true,
      pausedAt: '2026-08-28T01:00:00.000Z',
      lastCycleAt: null,
      defaultAutonomyLevel: 2,
      aiBudget: { enabled: true, monthlyUsd: 50, perCycleUsd: 3, reserveUsd: 1 },
      scheduler: { enabled: true, intervalMinutes: 60, maxRetries: 2, retryDelayMinutes: 5, lastRunAt: null, nextRunAt: '2026-08-28T02:00:00.000Z', running: false, retryQueue: [] },
    },
  })
  const store = await new PostgresSystemStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeSystemSections, true)
  assert.deepEqual(snapshot.stateDocument.system, {})
  assert.deepEqual(Object.keys(snapshot.system).sort(), ['aiBudget', 'core', 'scheduler'])

  const hydrated = await store.read()
  assert.equal(hydrated.system.paused, true)
  assert.equal(hydrated.system.aiBudget.monthlyUsd, 50)
  assert.equal(hydrated.system.scheduler.intervalMinutes, 60)
})

test('native system section mutation locks and updates only the requested section', async () => {
  const pool = fakePool({ legacySystem: { paused: false } })
  const store = await new PostgresSystemStore(pool).init()
  const before = pool.snapshot()

  const updated = await mutateSystemSection(store, 'scheduler', (scheduler) => {
    scheduler.enabled = true
    scheduler.intervalMinutes = 30
    return structuredClone(scheduler)
  })

  const after = pool.snapshot()
  assert.equal(updated.enabled, true)
  assert.equal(updated.intervalMinutes, 30)
  assert.equal(after.system.scheduler.revision, before.system.scheduler.revision + 1)
  assert.equal(after.system.core.revision, before.system.core.revision)
  assert.equal(after.system.aiBudget.revision, before.system.aiBudget.revision)

  const recent = after.queries.slice(before.queries.length)
  const locks = recent.filter((item) => item.text.includes('FROM bloggers_system_settings') && item.text.includes('FOR UPDATE'))
  assert.equal(locks.length, 1)
  assert.deepEqual(locks[0].params, ['scheduler'])
})

test('legacy state.system mutate compatibility persists to native rows without repopulating global system document', async () => {
  const pool = fakePool({ legacySystem: { paused: false } })
  const store = await new PostgresSystemStore(pool).init()

  await store.mutate((state) => {
    state.system.paused = true
    state.system.pausedAt = '2026-08-28T03:00:00.000Z'
  })

  const snapshot = pool.snapshot()
  assert.deepEqual(snapshot.stateDocument.system, {})
  assert.equal(snapshot.system.core.document.paused, true)
  const hydrated = await store.read()
  assert.equal(hydrated.system.paused, true)
  assert.equal(hydrated.system.pausedAt, '2026-08-28T03:00:00.000Z')
})

test('generic PostgresSystemStore mutate fails closed if code tries to alter a normalized non-system collection', async () => {
  const pool = fakePool({ legacySystem: { paused: false } })
  const store = await new PostgresSystemStore(pool).init()

  await assert.rejects(
    () => store.mutate((state) => {
      state.blogs.push({ id: 'illegal', slug: 'illegal' })
    }),
    /may only change state\.system/,
  )
  assert.deepEqual(pool.snapshot().stateDocument.blogs, [])
})

test('PostgreSQL system revision tokens reject stale AI budget and Scheduler writes without changing newer values', async () => {
  const pool = fakePool({ legacySystem: { paused: false } })
  const store = await new PostgresSystemStore(pool).init()
  const initial = await settingsVersions(store)

  assert.match(initial.aiBudget, /^r:\d+$/)
  assert.match(initial.scheduler, /^r:\d+$/)

  await configureAiBudgetVersioned(store, { monthlyUsd: 40 }, { expectedVersion: initial.aiBudget })
  await configureSchedulerVersioned(store, {
    enabled: true,
    intervalMinutes: 45,
  }, { expectedVersion: initial.scheduler, now: 1_800_000_000_000 })

  const afterFirstSave = await settingsVersions(store)
  assert.notEqual(afterFirstSave.aiBudget, initial.aiBudget)
  assert.notEqual(afterFirstSave.scheduler, initial.scheduler)

  await assert.rejects(
    () => configureAiBudgetVersioned(store, { monthlyUsd: 90 }, { expectedVersion: initial.aiBudget }),
    (error) => error?.code === 'SYSTEM_VERSION_CONFLICT'
      && error?.status === 409
      && error?.section === 'aiBudget',
  )
  await assert.rejects(
    () => configureSchedulerVersioned(store, { intervalMinutes: 15 }, {
      expectedVersion: initial.scheduler,
      now: 1_800_000_100_000,
    }),
    (error) => error?.code === 'SYSTEM_VERSION_CONFLICT'
      && error?.status === 409
      && error?.section === 'scheduler',
  )

  const state = await store.read()
  assert.equal(state.system.aiBudget.monthlyUsd, 40)
  assert.equal(state.system.scheduler.intervalMinutes, 45)
  assert.deepEqual(await settingsVersions(store), afterFirstSave)
})
