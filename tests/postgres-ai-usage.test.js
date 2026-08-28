import test from 'node:test'
import assert from 'node:assert/strict'
import { appendAiUsageEntries, listAiUsageEntries } from '../src/ai-usage-store.js'
import { PostgresRuntimeStore } from '../src/postgres-runtime-store.js'

function fakePool({ legacyAiUsage = [] } = {}) {
  let stateDocument = {
    version: 2,
    system: { aiBudget: { enabled: true, monthlyUsd: 20, perCycleUsd: 2, reserveUsd: 0.5 } },
    blogs: [],
    ideas: [],
    articles: [],
    approvals: [],
    activities: [],
    analytics: [],
    experiments: [],
    workflows: [],
    memories: [],
    aiUsage: structuredClone(legacyAiUsage),
    jobs: [],
    locks: [],
  }
  const aiUsage = []
  const queries = []

  function saveUsage(params) {
    const [id, blogId, createdAt, raw] = params
    const document = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
    const row = { id, blog_id: blogId, created_at: createdAt, document }
    const index = aiUsage.findIndex((item) => item.id === id)
    if (index >= 0) aiUsage.splice(index, 1)
    aiUsage.push(row)
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
    if (/INSERT INTO bloggers_ai_usage/.test(text)) {
      return { rows: [saveUsage(params)] }
    }
    if (/DELETE FROM bloggers_ai_usage/.test(text)) {
      const keep = Number(params[0] ?? 10_000)
      aiUsage.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      aiUsage.splice(keep)
      return { rows: [] }
    }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_ai_usage/.test(text)) {
      let rows = structuredClone(aiUsage)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((item) => item.blog_id === params[0])
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      const limit = Number(params.at(-1) ?? 10_000)
      return { rows: rows.slice(0, limit) }
    }
    if (/SELECT id, blog_id, captured_at, document\s+FROM bloggers_analytics/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_activities/.test(text)) return { rows: [] }
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
    snapshot() { return { stateDocument: structuredClone(stateDocument), aiUsage: structuredClone(aiUsage), queries: structuredClone(queries) } },
  }
}

test('PostgresRuntimeStore promotes legacy AI usage during init and clears the global state copy', async () => {
  const pool = fakePool({
    legacyAiUsage: [{ id: 'usage-old', blogId: 'blog-1', createdAt: '2026-08-28T01:00:00.000Z', operation: 'decide', estimatedCostUsd: 0.02 }],
  })
  const store = await new PostgresRuntimeStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeAiUsage, true)
  assert.equal(snapshot.aiUsage.length, 1)
  assert.equal(snapshot.aiUsage[0].id, 'usage-old')
  assert.equal(snapshot.stateDocument.aiUsage.length, 0)
  assert.ok(snapshot.queries.some((item) => item.text.includes('CREATE TABLE IF NOT EXISTS bloggers_ai_usage')))

  const hydrated = await store.read()
  assert.equal(hydrated.aiUsage.length, 1)
  assert.equal(hydrated.aiUsage[0].estimatedCostUsd, 0.02)
})

test('native AI usage append/list supports batches and blog filtering', async () => {
  const pool = fakePool()
  const store = await new PostgresRuntimeStore(pool).init()
  const first = { id: 'usage-1', blogId: 'blog-1', workflowId: 'wf-1', createdAt: '2026-08-28T01:00:00.000Z', operation: 'decide', inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.01 }
  const second = { id: 'usage-2', blogId: 'blog-2', workflowId: 'wf-2', createdAt: '2026-08-28T02:00:00.000Z', operation: 'draft', inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.03 }

  await appendAiUsageEntries(store, [first, second])

  const all = await listAiUsageEntries(store, { limit: 10 })
  const blogOne = await listAiUsageEntries(store, { blogId: 'blog-1', limit: 10 })

  assert.deepEqual(all.map((item) => item.id), ['usage-2', 'usage-1'])
  assert.equal(blogOne.length, 1)
  assert.equal(blogOne[0].operation, 'decide')
  assert.equal(blogOne[0].estimatedCostUsd, 0.01)
  assert.ok(pool.snapshot().queries.some((item) => item.text.includes('DELETE FROM bloggers_ai_usage')))
})
