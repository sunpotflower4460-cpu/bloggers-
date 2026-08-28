import test from 'node:test'
import assert from 'node:assert/strict'
import { listWorkflows, upsertWorkflow } from '../src/workflow-store.js'
import { PostgresRuntimeStore } from '../src/postgres-runtime-store.js'

function fakePool({ legacyWorkflows = [] } = {}) {
  let stateDocument = {
    version: 2,
    system: {},
    blogs: [],
    ideas: [],
    articles: [],
    approvals: [],
    activities: [],
    analytics: [],
    experiments: [],
    workflows: structuredClone(legacyWorkflows),
    memories: [],
    aiUsage: [],
    jobs: [],
    locks: [],
  }
  const workflows = []
  const queries = []

  function saveWorkflow(params) {
    const [id, blogId, startedAt, finishedAt, status, raw] = params
    const document = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
    const row = { id, blog_id: blogId, started_at: startedAt, finished_at: finishedAt, status, document }
    const index = workflows.findIndex((item) => item.id === id)
    if (index >= 0) workflows.splice(index, 1)
    workflows.push(row)
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
    if (/INSERT INTO bloggers_workflows/.test(text)) return { rows: [saveWorkflow(params)] }
    if (/DELETE FROM bloggers_workflows/.test(text)) {
      const keep = Number(params[0] ?? 2000)
      workflows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id.localeCompare(a.id))
      workflows.splice(keep)
      return { rows: [] }
    }
    if (/SELECT id, blog_id, started_at, finished_at, status, document\s+FROM bloggers_workflows/.test(text)) {
      let rows = structuredClone(workflows)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((item) => item.blog_id === params[0])
      rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id.localeCompare(a.id))
      const limit = Number(params.at(-1) ?? 2000)
      return { rows: rows.slice(0, limit) }
    }
    if (/SELECT id, blog_id, captured_at, document\s+FROM bloggers_analytics/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_activities/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_ai_usage/.test(text)) return { rows: [] }
    if (/SELECT document FROM bloggers_state WHERE state_key = \$1/.test(text)) return { rows: [{ document: structuredClone(stateDocument) }] }
    if (/FROM bloggers_jobs/.test(text) || /FROM bloggers_operation_leases/.test(text)) return { rows: [] }
    return { rows: [] }
  }

  const client = { query, release() {} }
  return {
    async connect() { return client },
    query,
    snapshot() { return { stateDocument: structuredClone(stateDocument), workflows: structuredClone(workflows), queries: structuredClone(queries) } },
  }
}

test('PostgresRuntimeStore promotes legacy workflows during init and clears the global state copy', async () => {
  const pool = fakePool({
    legacyWorkflows: [{ id: 'wf-old', blogId: 'blog-1', startedAt: '2026-08-28T01:00:00.000Z', finishedAt: '2026-08-28T01:02:00.000Z', status: 'completed' }],
  })
  const store = await new PostgresRuntimeStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeWorkflows, true)
  assert.equal(snapshot.workflows.length, 1)
  assert.equal(snapshot.workflows[0].id, 'wf-old')
  assert.equal(snapshot.stateDocument.workflows.length, 0)
  assert.ok(snapshot.queries.some((item) => item.text.includes('CREATE TABLE IF NOT EXISTS bloggers_workflows')))

  const hydrated = await store.read()
  assert.equal(hydrated.workflows.length, 1)
  assert.equal(hydrated.workflows[0].status, 'completed')
})

test('native workflow upsert replaces running state and preserves a single lifecycle row', async () => {
  const pool = fakePool()
  const store = await new PostgresRuntimeStore(pool).init()
  const running = { id: 'wf-1', blogId: 'blog-1', trigger: 'scheduler', status: 'running', startedAt: '2026-08-28T01:00:00.000Z', finishedAt: null, aiCostUsd: 0 }
  const completed = { ...running, status: 'completed', finishedAt: '2026-08-28T01:03:00.000Z', aiCostUsd: 0.04, decision: { action: 'CREATE' } }
  const other = { id: 'wf-2', blogId: 'blog-2', trigger: 'manual', status: 'failed', startedAt: '2026-08-28T02:00:00.000Z', finishedAt: '2026-08-28T02:01:00.000Z', error: 'test' }

  await upsertWorkflow(store, running)
  await upsertWorkflow(store, completed)
  await upsertWorkflow(store, other)

  const all = await listWorkflows(store, { limit: 10 })
  const blogOne = await listWorkflows(store, { blogId: 'blog-1', limit: 10 })

  assert.deepEqual(all.map((item) => item.id), ['wf-2', 'wf-1'])
  assert.equal(blogOne.length, 1)
  assert.equal(blogOne[0].status, 'completed')
  assert.equal(blogOne[0].aiCostUsd, 0.04)
  assert.equal(pool.snapshot().workflows.filter((item) => item.id === 'wf-1').length, 1)
  assert.ok(pool.snapshot().queries.some((item) => item.text.includes('DELETE FROM bloggers_workflows')))
})
