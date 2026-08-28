import test from 'node:test'
import assert from 'node:assert/strict'
import { appendActivity, listActivities } from '../src/activity-store.js'
import { PostgresRuntimeStore } from '../src/postgres-runtime-store.js'

function fakePool({ legacyActivities = [] } = {}) {
  let stateDocument = {
    version: 2,
    system: {},
    blogs: [],
    ideas: [],
    articles: [],
    approvals: [],
    activities: structuredClone(legacyActivities),
    analytics: [],
    experiments: [],
    workflows: [],
    memories: [],
    aiUsage: [],
    jobs: [],
    locks: [],
  }
  const activities = []
  const queries = []

  function saveActivity(params) {
    const [id, blogId, createdAt, raw] = params
    const document = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
    const row = { id, blog_id: blogId, created_at: createdAt, document }
    const index = activities.findIndex((item) => item.id === id)
    if (index >= 0) activities.splice(index, 1)
    activities.push(row)
    return row
  }

  async function query(sql, params = []) {
    const text = String(sql)
    queries.push({ text, params: structuredClone(params) })

    if (/SELECT document FROM bloggers_state WHERE state_key = \$1 FOR UPDATE/.test(text)) {
      return { rows: [{ document: structuredClone(stateDocument) }] }
    }
    if (/UPDATE bloggers_state\s+SET document = \$2::jsonb/.test(text)) {
      stateDocument = typeof params[1] === 'string' ? JSON.parse(params[1]) : structuredClone(params[1])
      return { rows: [] }
    }
    if (/INSERT INTO bloggers_activities/.test(text)) {
      return { rows: [saveActivity(params)] }
    }
    if (/DELETE FROM bloggers_activities/.test(text)) {
      const keep = Number(params[0] ?? 1000)
      activities.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      activities.splice(keep)
      return { rows: [] }
    }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_activities/.test(text)) {
      let rows = structuredClone(activities)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((item) => item.blog_id === params[0])
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      const limit = Number(params.at(-1) ?? 1000)
      return { rows: rows.slice(0, limit) }
    }
    if (/SELECT id, blog_id, captured_at, document\s+FROM bloggers_analytics/.test(text)) return { rows: [] }
    if (/SELECT document FROM bloggers_state WHERE state_key = \$1/.test(text)) {
      return { rows: [{ document: structuredClone(stateDocument) }] }
    }
    if (/FROM bloggers_jobs/.test(text) || /FROM bloggers_operation_leases/.test(text)) return { rows: [] }
    return { rows: [] }
  }

  const client = { query, release() {} }
  return {
    async connect() { return client },
    query,
    snapshot() { return { stateDocument: structuredClone(stateDocument), activities: structuredClone(activities), queries: structuredClone(queries) } },
  }
}

test('PostgresRuntimeStore promotes legacy activity log during init and clears the global state copy', async () => {
  const pool = fakePool({
    legacyActivities: [{ id: 'activity-old', blogId: 'blog-1', createdAt: '2026-08-28T01:00:00.000Z', agent: 'observer', message: 'legacy' }],
  })
  const store = await new PostgresRuntimeStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeActivities, true)
  assert.equal(snapshot.activities.length, 1)
  assert.equal(snapshot.activities[0].id, 'activity-old')
  assert.equal(snapshot.stateDocument.activities.length, 0)
  assert.ok(snapshot.queries.some((item) => item.text.includes('CREATE TABLE IF NOT EXISTS bloggers_activities')))
  assert.ok(snapshot.queries.some((item) => item.text.includes('FOR UPDATE')))

  const hydrated = await store.read()
  assert.equal(hydrated.activities.length, 1)
  assert.equal(hydrated.activities[0].message, 'legacy')
})

test('native activity append/list preserves detail and supports blog filtering', async () => {
  const pool = fakePool()
  const store = await new PostgresRuntimeStore(pool).init()
  const first = { id: 'activity-1', blogId: 'blog-1', createdAt: '2026-08-28T01:00:00.000Z', agent: 'director', type: 'cycle.decide', message: 'CREATE', detail: { confidence: 0.8 } }
  const second = { id: 'activity-2', blogId: 'blog-2', createdAt: '2026-08-28T02:00:00.000Z', agent: 'publisher', type: 'content.published', message: 'published' }

  await appendActivity(store, first)
  await appendActivity(store, second)

  const all = await listActivities(store, { limit: 10 })
  const blogOne = await listActivities(store, { blogId: 'blog-1', limit: 10 })

  assert.deepEqual(all.map((item) => item.id), ['activity-2', 'activity-1'])
  assert.equal(blogOne.length, 1)
  assert.equal(blogOne[0].message, 'CREATE')
  assert.deepEqual(blogOne[0].detail, { confidence: 0.8 })
  assert.ok(pool.snapshot().queries.some((item) => item.text.includes('DELETE FROM bloggers_activities')))
})
