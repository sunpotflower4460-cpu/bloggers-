import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryConnector } from '../src/connectors.js'
import { mutateBlogRecord } from '../src/blog-store.js'
import { PostgresConfigStore } from '../src/postgres-config-store.js'

function fakePool({ legacyBlogs = [] } = {}) {
  let stateDocument = {
    version: 5,
    system: {},
    blogs: structuredClone(legacyBlogs),
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
  const blogs = new Map()
  const queries = []

  function rowFromBlog(blog) {
    return {
      id: blog.id,
      slug: blog.slug,
      active: blog.active !== false,
      created_at: blog.createdAt,
      updated_at: blog.updatedAt,
      document: structuredClone(blog),
    }
  }

  function saveBlog(params, { strictCreate = false } = {}) {
    const [id, slug, active, createdAt, updatedAt, raw] = params
    const document = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
    if (strictCreate && [...blogs.values()].some((item) => item.slug === slug)) {
      const error = new Error('duplicate slug')
      error.code = '23505'
      throw error
    }
    const conflict = [...blogs.values()].find((item) => item.slug === slug && item.id !== id)
    if (conflict) {
      const error = new Error('duplicate slug')
      error.code = '23505'
      throw error
    }
    Object.assign(document, { id, slug, active, createdAt, updatedAt })
    blogs.set(id, document)
    return document
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

    if (/INSERT INTO bloggers_blogs/.test(text)) {
      const strictCreate = !/ON CONFLICT/.test(text)
      saveBlog(params, { strictCreate })
      return { rows: [] }
    }
    if (/SELECT id, slug, active, created_at, updated_at, document\s+FROM bloggers_blogs\s+WHERE id = \$1\s+FOR UPDATE/.test(text)) {
      const blog = blogs.get(params[0])
      return { rows: blog ? [rowFromBlog(blog)] : [] }
    }
    if (/SELECT id, slug, active, created_at, updated_at, document\s+FROM bloggers_blogs/.test(text)) {
      let rows = [...blogs.values()].map(rowFromBlog)
      if (/WHERE active = \$1/.test(text)) rows = rows.filter((row) => row.active === Boolean(params[0]))
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id))
      return { rows: rows.slice(0, Number(params.at(-1) ?? 1000)) }
    }

    if (/SELECT pg_advisory_xact_lock/.test(text)) return { rows: [] }
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
        blogs: [...blogs.values()].map((item) => structuredClone(item)),
        queries: structuredClone(queries),
      }
    },
  }
}

function sampleBlog(overrides = {}) {
  return {
    id: 'blog-1',
    name: 'Native Blog',
    slug: 'native-blog',
    active: true,
    connector: { type: 'memory' },
    analytics: {},
    research: { requireCitations: false, sources: [] },
    brain: { purpose: 'test', audience: 'reader', voice: 'clear', editorialPolicy: '', monetization: '', topics: ['AI'] },
    autonomy: { level: 4, allowCreate: true, allowUpdate: true, allowPublish: true, allowDelete: false },
    remotePosts: [],
    createdAt: '2026-08-28T01:00:00.000Z',
    updatedAt: '2026-08-28T01:00:00.000Z',
    ...overrides,
  }
}

test('PostgresConfigStore promotes legacy Blog Brain records and hydrates them on read', async () => {
  const pool = fakePool({ legacyBlogs: [sampleBlog()] })
  const store = await new PostgresConfigStore(pool).init()
  const snapshot = pool.snapshot()

  assert.equal(store.capabilities.nativeBlogs, true)
  assert.equal(snapshot.stateDocument.blogs.length, 0)
  assert.equal(snapshot.blogs.length, 1)
  assert.equal(snapshot.blogs[0].brain.purpose, 'test')

  const hydrated = await store.read()
  assert.equal(hydrated.blogs.length, 1)
  assert.equal(hydrated.blogs[0].slug, 'native-blog')
  assert.deepEqual(hydrated.blogs[0].brain.topics, ['AI'])
})

test('native Blog Brain mutation locks one blog row and persists configuration changes', async () => {
  const pool = fakePool()
  const store = await new PostgresConfigStore(pool).init()
  await store.blogCreate(sampleBlog())

  const updated = await mutateBlogRecord(store, 'blog-1', (blog) => {
    blog.brain.voice = 'measured'
    blog.autonomy.level = 3
    blog.updatedAt = '2026-08-28T02:00:00.000Z'
    return structuredClone(blog)
  })

  assert.equal(updated.brain.voice, 'measured')
  assert.equal(updated.autonomy.level, 3)
  const hydrated = await store.read()
  assert.equal(hydrated.blogs[0].brain.voice, 'measured')
  assert.equal(hydrated.blogs[0].autonomy.level, 3)
  assert.ok(pool.snapshot().queries.some((item) => item.text.includes('FROM bloggers_blogs') && item.text.includes('FOR UPDATE')))
})

test('MemoryConnector writes remotePosts through native Blog row mutation and remains article-idempotent', async () => {
  const pool = fakePool()
  const store = await new PostgresConfigStore(pool).init()
  const blog = sampleBlog()
  await store.blogCreate(blog)
  const connector = new MemoryConnector({ blog, store })
  const article = { id: 'article-1', title: 'One draft', body: 'body' }

  const first = await connector.createDraft(article)
  const second = await connector.createDraft(article)
  assert.equal(second.id, first.id)

  await connector.publishPost(first.id)
  const hydrated = await store.read()
  assert.equal(hydrated.blogs[0].remotePosts.length, 1)
  assert.equal(hydrated.blogs[0].remotePosts[0].status, 'publish')
  assert.equal(hydrated.blogs[0].remotePosts[0].sourceArticleId, 'article-1')

  const rowLocks = pool.snapshot().queries.filter((item) => item.text.includes('FROM bloggers_blogs') && item.text.includes('FOR UPDATE'))
  assert.ok(rowLocks.length >= 3)
})

test('native blog create rejects duplicate slugs instead of overwriting another Blog Brain', async () => {
  const pool = fakePool()
  const store = await new PostgresConfigStore(pool).init()
  await store.blogCreate(sampleBlog())
  await assert.rejects(
    () => store.blogCreate(sampleBlog({ id: 'blog-2', name: 'Duplicate', createdAt: '2026-08-28T02:00:00.000Z', updatedAt: '2026-08-28T02:00:00.000Z' })),
    /A blog with this slug already exists/,
  )
})
