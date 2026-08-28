import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateExperiments } from '../src/experiments.js'
import { PostgresLearningStore } from '../src/postgres-learning-store.js'

function fakePool({ legacyExperiments = [], legacyMemories = [] } = {}) {
  let stateDocument = {
    version: 5,
    system: {},
    blogs: [],
    ideas: [],
    articles: [],
    approvals: [],
    activities: [],
    analytics: [],
    experiments: structuredClone(legacyExperiments),
    workflows: [],
    memories: structuredClone(legacyMemories),
    aiUsage: [],
    jobs: [],
    locks: [],
  }
  const experiments = new Map()
  const memories = new Map()
  const queries = []

  function rowFromExperiment(experiment) {
    return {
      id: experiment.id,
      blog_id: experiment.blogId,
      article_id: experiment.articleId ?? null,
      action: experiment.action,
      status: experiment.status,
      created_at: experiment.createdAt,
      completed_at: experiment.completedAt ?? null,
      document: structuredClone(experiment),
    }
  }

  function rowFromMemory(memory) {
    return {
      id: memory.id,
      blog_id: memory.blogId ?? null,
      scope: memory.scope ?? 'blog',
      type: memory.type ?? 'memory',
      source_experiment_id: memory.sourceExperimentId ?? null,
      created_at: memory.createdAt,
      document: structuredClone(memory),
    }
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
    if (/SELECT document FROM bloggers_state WHERE state_key = \$1/.test(text)) {
      return { rows: [{ document: structuredClone(stateDocument) }] }
    }

    if (/INSERT INTO bloggers_experiments/.test(text)) {
      const [id, blogId, articleId, action, status, createdAt, completedAt, raw] = params
      const experiment = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
      Object.assign(experiment, { id, blogId, articleId, action, status, createdAt, completedAt })
      experiments.set(id, experiment)
      return { rows: [] }
    }
    if (/INSERT INTO bloggers_memories/.test(text)) {
      const [id, blogId, scope, type, sourceExperimentId, createdAt, raw] = params
      const memory = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
      Object.assign(memory, { id, blogId, scope, type, sourceExperimentId, createdAt })
      memories.set(id, memory)
      return { rows: [] }
    }

    if (/SELECT id, blog_id, article_id, action, status, created_at, completed_at, document\s+FROM bloggers_experiments/.test(text)) {
      let rows = [...experiments.values()].map(rowFromExperiment)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((row) => row.blog_id === params[0])
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      const limit = /LIMIT/.test(text) ? Number(params.at(-1) ?? 5000) : rows.length
      return { rows: rows.slice(0, limit) }
    }
    if (/SELECT id, blog_id, scope, type, source_experiment_id, created_at, document\s+FROM bloggers_memories/.test(text)) {
      let rows = [...memories.values()].map(rowFromMemory)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((row) => row.blog_id === params[0])
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      const limit = /LIMIT/.test(text) ? Number(params.at(-1) ?? 2000) : rows.length
      return { rows: rows.slice(0, limit) }
    }

    if (/DELETE FROM bloggers_experiments/.test(text) || /DELETE FROM bloggers_memories/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_ideas/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, idea_id, status, created_at, updated_at, document\s+FROM bloggers_articles/.test(text)) return { rows: [] }
    if (/SELECT id, blog_id, article_id, status, created_at, resolved_at, document\s+FROM bloggers_approvals/.test(text)) return { rows: [] }
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
        experiments: [...experiments.values()].map((item) => structuredClone(item)),
        memories: [...memories.values()].map((item) => structuredClone(item)),
        queries: structuredClone(queries),
      }
    },
  }
}

test('PostgresLearningStore promotes legacy experiments and memories and hydrates them on read', async () => {
  const pool = fakePool({
    legacyExperiments: [{
      id: 'experiment-old',
      blogId: 'blog-1',
      articleId: 'article-1',
      action: 'CREATE',
      hypothesis: 'legacy experiment',
      targetMetric: 'clicks',
      baselineValue: 10,
      latestValue: 10,
      deltaPct: 0,
      observations: 0,
      status: 'running',
      result: null,
      confidence: 0,
      createdAt: '2026-08-28T01:00:00.000Z',
      completedAt: null,
    }],
    legacyMemories: [{
      id: 'memory-old',
      scope: 'blog',
      blogId: 'blog-1',
      type: 'experiment-learning',
      createdAt: '2026-08-28T00:00:00.000Z',
      confidence: 0.8,
      text: 'legacy learning',
      sourceExperimentId: 'experiment-before',
    }],
  })

  const store = await new PostgresLearningStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeExperimentMemoryTransaction, true)
  assert.equal(snapshot.stateDocument.experiments.length, 0)
  assert.equal(snapshot.stateDocument.memories.length, 0)
  assert.equal(snapshot.experiments.length, 1)
  assert.equal(snapshot.memories.length, 1)

  const hydrated = await store.read()
  assert.equal(hydrated.experiments[0].hypothesis, 'legacy experiment')
  assert.equal(hydrated.memories[0].text, 'legacy learning')
})

test('experiment completion and Blog Memory promotion commit in one serialized native transaction', async () => {
  const pool = fakePool()
  const store = await new PostgresLearningStore(pool).init()
  await store.experimentUpsert({
    id: 'experiment-1',
    blogId: 'blog-1',
    articleId: 'article-1',
    action: 'CREATE',
    hypothesis: 'clicks improve',
    targetMetric: 'clicks',
    baselineValue: 10,
    latestValue: 10,
    deltaPct: 0,
    observations: 2,
    status: 'running',
    result: null,
    confidence: 0.4,
    createdAt: '2026-08-28T02:00:00.000Z',
    completedAt: null,
  })

  const before = pool.snapshot().queries.length
  const result = await evaluateExperiments(store, 'blog-1', { clicks: 12 })
  const after = pool.snapshot()
  const transaction = after.queries.slice(before)
  const transactionQueries = transaction.map((item) => item.text)

  assert.equal(result.completed.length, 1)
  assert.equal(result.completed[0].result, 'positive')
  assert.equal(after.experiments[0].status, 'completed')
  assert.equal(after.memories.length, 1)
  assert.equal(after.memories[0].sourceExperimentId, 'experiment-1')

  const begin = transactionQueries.indexOf('BEGIN')
  const advisoryLock = transactionQueries.findIndex((text) => text.includes('pg_advisory_xact_lock'))
  const experimentWrite = transactionQueries.findIndex((text) => text.includes('INSERT INTO bloggers_experiments'))
  const memoryWrite = transactionQueries.findIndex((text) => text.includes('INSERT INTO bloggers_memories'))
  const commit = transactionQueries.lastIndexOf('COMMIT')
  assert.ok(begin >= 0)
  assert.ok(advisoryLock > begin)
  assert.deepEqual(transaction[advisoryLock].params, ['bloggers-learning:blog-1'])
  assert.ok(experimentWrite > advisoryLock)
  assert.ok(memoryWrite > experimentWrite)
  assert.ok(commit > memoryWrite)

  const hydrated = await store.read()
  assert.equal(hydrated.experiments[0].status, 'completed')
  assert.equal(hydrated.memories[0].type, 'experiment-learning')
})
