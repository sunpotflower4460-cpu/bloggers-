import test from 'node:test'
import assert from 'node:assert/strict'
import { appendIdea, listIdeas } from '../src/idea-store.js'
import { PostgresEditorialStore } from '../src/postgres-editorial-store.js'

function fakePool({ legacyIdeas = [] } = {}) {
  let stateDocument = {
    version: 2,
    system: {},
    blogs: [],
    ideas: structuredClone(legacyIdeas),
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
  const ideas = []
  const queries = []

  function saveIdea(params) {
    const [id, blogId, createdAt, raw] = params
    const document = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
    const row = { id, blog_id: blogId, created_at: createdAt, document }
    const index = ideas.findIndex((item) => item.id === id)
    if (index >= 0) ideas.splice(index, 1)
    ideas.push(row)
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
    if (/INSERT INTO bloggers_ideas/.test(text)) return { rows: [saveIdea(params)] }
    if (/DELETE FROM bloggers_ideas/.test(text)) {
      const keep = Number(params[0] ?? 3000)
      ideas.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      ideas.splice(keep)
      return { rows: [] }
    }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_ideas/.test(text)) {
      let rows = structuredClone(ideas)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((item) => item.blog_id === params[0])
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      const limit = Number(params.at(-1) ?? 3000)
      return { rows: rows.slice(0, limit) }
    }
    if (/SELECT document FROM bloggers_state WHERE state_key = \$1/.test(text)) {
      return { rows: [{ document: structuredClone(stateDocument) }] }
    }
    if (/FROM bloggers_jobs/.test(text) || /FROM bloggers_operation_leases/.test(text)) return { rows: [] }
    if (/FROM bloggers_analytics/.test(text) || /FROM bloggers_activities/.test(text)) return { rows: [] }
    if (/FROM bloggers_ai_usage/.test(text) || /FROM bloggers_workflows/.test(text)) return { rows: [] }
    return { rows: [] }
  }

  const client = { query, release() {} }
  return {
    async connect() { return client },
    query,
    snapshot() {
      return {
        stateDocument: structuredClone(stateDocument),
        ideas: structuredClone(ideas),
        queries: structuredClone(queries),
      }
    },
  }
}

test('PostgresEditorialStore promotes legacy ideas during init and clears the global state copy', async () => {
  const pool = fakePool({
    legacyIdeas: [{
      id: 'idea-old',
      blogId: 'blog-1',
      action: 'CREATE',
      title: 'Legacy idea',
      createdAt: '2026-08-28T01:00:00.000Z',
    }],
  })
  const store = await new PostgresEditorialStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeIdeas, true)
  assert.equal(snapshot.ideas.length, 1)
  assert.equal(snapshot.ideas[0].id, 'idea-old')
  assert.equal(snapshot.stateDocument.ideas.length, 0)
  assert.ok(snapshot.queries.some((item) => item.text.includes('CREATE TABLE IF NOT EXISTS bloggers_ideas')))
  assert.ok(snapshot.queries.some((item) => item.text.includes('FOR UPDATE')))

  const hydrated = await store.read()
  assert.equal(hydrated.ideas.length, 1)
  assert.equal(hydrated.ideas[0].title, 'Legacy idea')
})

test('native idea append/list preserves Director metadata and supports blog filtering', async () => {
  const pool = fakePool()
  const store = await new PostgresEditorialStore(pool).init()
  const first = {
    id: 'idea-1',
    blogId: 'blog-1',
    action: 'CREATE',
    topic: 'automation',
    title: 'First idea',
    rationale: 'measured opportunity',
    confidence: 0.82,
    status: 'proposed',
    createdAt: '2026-08-28T01:00:00.000Z',
  }
  const second = {
    id: 'idea-2',
    blogId: 'blog-2',
    action: 'WAIT',
    topic: '',
    title: '',
    rationale: 'no useful opportunity',
    confidence: 0.4,
    status: 'observing',
    createdAt: '2026-08-28T02:00:00.000Z',
  }

  await appendIdea(store, first)
  await appendIdea(store, second)

  const all = await listIdeas(store, { limit: 10 })
  const blogOne = await listIdeas(store, { blogId: 'blog-1', limit: 10 })

  assert.deepEqual(all.map((item) => item.id), ['idea-2', 'idea-1'])
  assert.equal(blogOne.length, 1)
  assert.equal(blogOne[0].rationale, 'measured opportunity')
  assert.equal(blogOne[0].confidence, 0.82)
  assert.ok(pool.snapshot().queries.some((item) => item.text.includes('DELETE FROM bloggers_ideas')))
})
