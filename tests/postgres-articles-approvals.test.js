import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveApprovalAndArticle, saveArticleAndApproval } from '../src/article-approval-store.js'
import { PostgresEditorialStore } from '../src/postgres-editorial-store.js'

function fakePool({ legacyArticles = [], legacyApprovals = [] } = {}) {
  let stateDocument = {
    version: 5,
    system: {},
    blogs: [],
    ideas: [],
    articles: structuredClone(legacyArticles),
    approvals: structuredClone(legacyApprovals),
    activities: [],
    analytics: [],
    experiments: [],
    workflows: [],
    memories: [],
    aiUsage: [],
    jobs: [],
    locks: [],
  }
  const articles = new Map()
  const approvals = new Map()
  const ideas = new Map()
  const queries = []

  function rowFromArticle(article) {
    return {
      id: article.id,
      blog_id: article.blogId,
      idea_id: article.ideaId ?? null,
      status: article.status,
      created_at: article.createdAt,
      updated_at: article.updatedAt,
      document: structuredClone(article),
    }
  }

  function rowFromApproval(approval) {
    return {
      id: approval.id,
      blog_id: approval.blogId,
      article_id: approval.articleId ?? null,
      status: approval.status,
      created_at: approval.createdAt,
      resolved_at: approval.resolvedAt ?? null,
      document: structuredClone(approval),
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

    if (/INSERT INTO bloggers_articles/.test(text)) {
      const [id, blogId, ideaId, status, createdAt, updatedAt, raw] = params
      const article = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
      Object.assign(article, { id, blogId, ideaId, status, createdAt, updatedAt })
      articles.set(id, article)
      return { rows: [] }
    }
    if (/INSERT INTO bloggers_approvals/.test(text)) {
      const [id, blogId, articleId, status, createdAt, resolvedAt, raw] = params
      const approval = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
      Object.assign(approval, { id, blogId, articleId, status, createdAt, resolvedAt })
      approvals.set(id, approval)
      return { rows: [] }
    }
    if (/INSERT INTO bloggers_ideas/.test(text)) {
      const [id, blogId, createdAt, raw] = params
      const idea = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw)
      Object.assign(idea, { id, blogId, createdAt })
      ideas.set(id, idea)
      return { rows: [] }
    }

    if (/FROM bloggers_approvals\s+WHERE id = \$1\s+FOR UPDATE/.test(text)) {
      const approval = approvals.get(params[0])
      return { rows: approval ? [rowFromApproval(approval)] : [] }
    }
    if (/FROM bloggers_articles\s+WHERE id = \$1\s+FOR UPDATE/.test(text)) {
      const article = articles.get(params[0])
      return { rows: article ? [rowFromArticle(article)] : [] }
    }

    if (/SELECT id, blog_id, idea_id, status, created_at, updated_at, document\s+FROM bloggers_articles/.test(text)) {
      let rows = [...articles.values()].map(rowFromArticle)
      if (/WHERE blog_id = \$1/.test(text)) rows = rows.filter((row) => row.blog_id === params[0])
      rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id.localeCompare(a.id))
      return { rows: rows.slice(0, Number(params.at(-1) ?? 5000)) }
    }
    if (/SELECT id, blog_id, article_id, status, created_at, resolved_at, document\s+FROM bloggers_approvals/.test(text)) {
      let rows = [...approvals.values()].map(rowFromApproval)
      if (/blog_id = \$1/.test(text)) rows = rows.filter((row) => row.blog_id === params[0])
      const statusParamIndex = /status = \$2/.test(text) ? 1 : /status = \$1/.test(text) ? 0 : -1
      if (statusParamIndex >= 0) rows = rows.filter((row) => row.status === params[statusParamIndex])
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))
      return { rows: rows.slice(0, Number(params.at(-1) ?? 3000)) }
    }
    if (/SELECT id, blog_id, created_at, document\s+FROM bloggers_ideas/.test(text)) {
      return { rows: [...ideas.values()].map((idea) => ({ id: idea.id, blog_id: idea.blogId, created_at: idea.createdAt, document: structuredClone(idea) })) }
    }

    if (/DELETE FROM bloggers_articles/.test(text) || /DELETE FROM bloggers_approvals/.test(text) || /DELETE FROM bloggers_ideas/.test(text)) return { rows: [] }
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
        articles: [...articles.values()].map((item) => structuredClone(item)),
        approvals: [...approvals.values()].map((item) => structuredClone(item)),
        queries: structuredClone(queries),
      }
    },
  }
}

test('PostgresEditorialStore promotes legacy articles and approvals together and hydrates them on read', async () => {
  const pool = fakePool({
    legacyArticles: [{
      id: 'article-old',
      blogId: 'blog-1',
      ideaId: 'idea-old',
      action: 'CREATE',
      title: 'Legacy draft',
      body: 'body',
      status: 'draft',
      createdAt: '2026-08-28T01:00:00.000Z',
      updatedAt: '2026-08-28T01:00:00.000Z',
    }],
    legacyApprovals: [{
      id: 'approval-old',
      blogId: 'blog-1',
      articleId: 'article-old',
      action: 'PUBLISH',
      status: 'pending',
      reason: 'review',
      createdAt: '2026-08-28T01:01:00.000Z',
      resolvedAt: null,
    }],
  })

  const store = await new PostgresEditorialStore(pool).init()
  const snapshot = pool.snapshot()
  assert.equal(store.capabilities.nativeArticleApprovalTransaction, true)
  assert.equal(snapshot.stateDocument.articles.length, 0)
  assert.equal(snapshot.stateDocument.approvals.length, 0)
  assert.equal(snapshot.articles.length, 1)
  assert.equal(snapshot.approvals.length, 1)

  const hydrated = await store.read()
  assert.equal(hydrated.articles[0].title, 'Legacy draft')
  assert.equal(hydrated.approvals[0].articleId, 'article-old')
})

test('article + approval save and approval resolution use native paired transactions', async () => {
  const pool = fakePool()
  const store = await new PostgresEditorialStore(pool).init()
  const article = {
    id: 'article-1',
    blogId: 'blog-1',
    ideaId: 'idea-1',
    action: 'CREATE',
    title: 'Draft',
    body: 'body',
    status: 'draft',
    createdAt: '2026-08-28T02:00:00.000Z',
    updatedAt: '2026-08-28T02:00:00.000Z',
  }
  const approval = {
    id: 'approval-1',
    blogId: 'blog-1',
    articleId: 'article-1',
    action: 'PUBLISH',
    reason: 'review',
    status: 'pending',
    createdAt: '2026-08-28T02:01:00.000Z',
    resolvedAt: null,
  }

  await saveArticleAndApproval(store, article, approval)
  await resolveApprovalAndArticle(store, {
    approvalId: approval.id,
    approvalPatch: { status: 'approved', resolvedAt: '2026-08-28T02:05:00.000Z' },
    articleId: article.id,
    articlePatch: { status: 'published', remoteId: 'remote-1', updatedAt: '2026-08-28T02:05:00.000Z' },
  })

  const hydrated = await store.read()
  assert.equal(hydrated.articles.length, 1)
  assert.equal(hydrated.articles[0].status, 'published')
  assert.equal(hydrated.articles[0].remoteId, 'remote-1')
  assert.equal(hydrated.approvals.length, 1)
  assert.equal(hydrated.approvals[0].status, 'approved')
  assert.equal(hydrated.approvals[0].resolvedAt, '2026-08-28T02:05:00.000Z')

  const queryTexts = pool.snapshot().queries.map((item) => item.text)
  assert.ok(queryTexts.some((text) => text.includes('FROM bloggers_approvals') && text.includes('FOR UPDATE')))
  assert.ok(queryTexts.some((text) => text.includes('FROM bloggers_articles') && text.includes('FOR UPDATE')))
  assert.ok(queryTexts.filter((text) => text === 'BEGIN').length >= 2)
  assert.ok(queryTexts.filter((text) => text === 'COMMIT').length >= 2)
})
