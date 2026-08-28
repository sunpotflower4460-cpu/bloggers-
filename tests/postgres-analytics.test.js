import test from 'node:test'
import assert from 'node:assert/strict'
import { appendAnalyticsSnapshot, listAnalyticsSnapshots } from '../src/analytics-store.js'
import { PostgresRuntimeStore } from '../src/postgres-runtime-store.js'

function fakePool({ legacyAnalytics = [] } = {}) {
  let stateDocument = {
    version: 2,
    system: {},
    blogs: [],
    ideas: [],
    articles: [],
    approvals: [],
    activities: [],
    analytics: structuredClone(legacyAnalytics),
    experiments: [],
    workflows: [],
    memories: [],
    aiUsage: [],
    jobs: [],
    locks: [],
  }
  const analytics = []
  const queries = []

  function saveAnalytics(params) {
    const [id, blogId, capturedAt, raw] = params
    const document = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
    const row = { id, blog_id: blogId, captured_at: capturedAt, document }
    const index = analytics.findIndex((item) => item.id === id)
    if (index >= 0) analytics.splice(index, 1)
    analytics.push(row)
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
    if (/INSERT INTO bloggers_analytics/.test(text)) {
      return { rows: [saveAnalytics(params)] }
    }
    if (/DELETE FROM bloggers_analytics/.test(text)) {
      const keep = Number(params[0] ?? 5000)
      analytics.sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)) || b.id.localeCompare(a.id))
      analytics.splice(keep)
      return { rows: [] }
    }
    if (/SELECT id, blog_id, captured_at, document\s+FROM bloggers_analytics/.test(text)) {
      let rows = structuredClone(analytics)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((item) => item.blog_id === params[0])
      rows.sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)) || b.id.localeCompare(a.id))
      const limit = Number(params.at(-1) ?? 5000)
      return { rows: rows.slice(0, limit) }
    }
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
    snapshot() { return { stateDocument: structuredClone(stateDocument), analytics: structuredClone(analytics), queries: structuredClone(queries) } },
  }
}

test('PostgresRuntimeStore promotes legacy document analytics during init and clears the global state copy', async () => {
  const pool = fakePool({
    legacyAnalytics: [{ id: 'metric-old', blogId: 'blog-1', capturedAt: '2026-08-28T01:00:00.000Z', clicks: 12 }],
  })
  const store = await new PostgresRuntimeStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeAnalytics, true)
  assert.equal(snapshot.analytics.length, 1)
  assert.equal(snapshot.analytics[0].id, 'metric-old')
  assert.equal(snapshot.stateDocument.analytics.length, 0)
  assert.ok(snapshot.queries.some((item) => item.text.includes('CREATE TABLE IF NOT EXISTS bloggers_analytics')))
  assert.ok(snapshot.queries.some((item) => item.text.includes('FOR UPDATE')))
})

test('native analytics append/list preserves full snapshots and backend-neutral helpers dispatch to it', async () => {
  const pool = fakePool()
  const store = await new PostgresRuntimeStore(pool).init()
  const first = { id: 'metric-1', blogId: 'blog-1', capturedAt: '2026-08-28T01:00:00.000Z', clicks: 10, nested: { source: 'gsc' } }
  const second = { id: 'metric-2', blogId: 'blog-2', capturedAt: '2026-08-28T02:00:00.000Z', views: 22 }

  await appendAnalyticsSnapshot(store, first)
  await appendAnalyticsSnapshot(store, second)

  const all = await listAnalyticsSnapshots(store, { limit: 10 })
  const blogOne = await listAnalyticsSnapshots(store, { blogId: 'blog-1', limit: 10 })

  assert.deepEqual(all.map((item) => item.id), ['metric-2', 'metric-1'])
  assert.equal(blogOne.length, 1)
  assert.equal(blogOne[0].clicks, 10)
  assert.deepEqual(blogOne[0].nested, { source: 'gsc' })
  assert.ok(pool.snapshot().queries.some((item) => item.text.includes('DELETE FROM bloggers_analytics')))
})
