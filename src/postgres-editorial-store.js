// @feature F-004
// @feature F-006
// @feature F-012
import { PostgresRuntimeStore } from './postgres-runtime-store.js'
import { normalizeState } from './store.js'

const STATE_KEY = 'global'

function decodeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

function iso(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function hydratedDocument(row, { timeField = 'created_at' } = {}) {
  const document = structuredClone(decodeJson(row.document) ?? {})
  document.id ??= row.id
  document.blogId ??= row.blog_id
  if (timeField && row[timeField]) document.createdAt ??= iso(row[timeField])
  return document
}

function safeLimit(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.round(parsed)))
}

function mergePatch(target, patch = {}) {
  for (const [key, value] of Object.entries(patch ?? {})) target[key] = structuredClone(value)
  return target
}

export class PostgresEditorialStore extends PostgresRuntimeStore {
  #editorialPool

  constructor(pool) {
    super(pool)
    this.#editorialPool = pool
  }

  get capabilities() {
    return {
      ...super.capabilities,
      nativeIdeas: true,
      nativeArticles: true,
      nativeApprovals: true,
      nativeArticleApprovalTransaction: true,
    }
  }

  async init() {
    await super.init()
    await this.#editorialPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_ideas (
        id text PRIMARY KEY,
        blog_id text NOT NULL,
        created_at timestamptz NOT NULL,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#editorialPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_ideas_blog_created_idx
      ON bloggers_ideas (blog_id, created_at DESC)
    `)
    await this.#editorialPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_ideas_created_idx
      ON bloggers_ideas (created_at DESC)
    `)

    await this.#editorialPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_articles (
        id text PRIMARY KEY,
        blog_id text NOT NULL,
        idea_id text,
        status text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        document jsonb NOT NULL
      )
    `)
    await this.#editorialPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_articles_blog_updated_idx
      ON bloggers_articles (blog_id, updated_at DESC)
    `)
    await this.#editorialPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_articles_status_updated_idx
      ON bloggers_articles (status, updated_at DESC)
    `)

    await this.#editorialPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_approvals (
        id text PRIMARY KEY,
        blog_id text NOT NULL,
        article_id text,
        status text NOT NULL,
        created_at timestamptz NOT NULL,
        resolved_at timestamptz,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#editorialPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_approvals_status_created_idx
      ON bloggers_approvals (status, created_at DESC)
    `)
    await this.#editorialPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_approvals_blog_created_idx
      ON bloggers_approvals (blog_id, created_at DESC)
    `)

    await this.#promoteLegacyEditorial()
    return this
  }

  async #promoteLegacyEditorial() {
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        'SELECT document FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const state = normalizeState(decodeJson(locked.rows?.[0]?.document) ?? {})
      const ideas = Array.isArray(state.ideas) ? state.ideas : []
      const articles = Array.isArray(state.articles) ? state.articles : []
      const approvals = Array.isArray(state.approvals) ? state.approvals : []
      let changed = false

      for (const idea of ideas) {
        if (!idea?.id || !idea?.blogId || !idea?.createdAt) continue
        await this.#upsertIdea(client, idea)
        changed = true
      }
      for (const article of articles) {
        if (!article?.id || !article?.blogId || !article?.createdAt) continue
        await this.#upsertArticle(client, article)
        changed = true
      }
      for (const approval of approvals) {
        if (!approval?.id || !approval?.blogId || !approval?.createdAt) continue
        await this.#upsertApproval(client, approval)
        changed = true
      }

      if (changed) {
        state.ideas = []
        state.articles = []
        state.approvals = []
        await client.query(
          `UPDATE bloggers_state
           SET document = $2::jsonb, version = $3, updated_at = now()
           WHERE state_key = $1`,
          [STATE_KEY, JSON.stringify(state), Number(state.version || 1)],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async #upsertIdea(queryable, idea) {
    await queryable.query(
      `INSERT INTO bloggers_ideas
         (id, blog_id, created_at, document, updated_at)
       VALUES ($1, $2, $3::timestamptz, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         blog_id = EXCLUDED.blog_id,
         created_at = EXCLUDED.created_at,
         document = EXCLUDED.document,
         updated_at = now()`,
      [idea.id, idea.blogId, idea.createdAt, JSON.stringify(idea)],
    )
  }

  async #upsertArticle(queryable, article) {
    const createdAt = article.createdAt ?? article.updatedAt ?? new Date().toISOString()
    const updatedAt = article.updatedAt ?? createdAt
    await queryable.query(
      `INSERT INTO bloggers_articles
         (id, blog_id, idea_id, status, created_at, updated_at, document)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         blog_id = EXCLUDED.blog_id,
         idea_id = EXCLUDED.idea_id,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         document = EXCLUDED.document`,
      [article.id, article.blogId, article.ideaId ?? null, article.status ?? 'draft', createdAt, updatedAt, JSON.stringify(article)],
    )
  }

  async #upsertApproval(queryable, approval) {
    await queryable.query(
      `INSERT INTO bloggers_approvals
         (id, blog_id, article_id, status, created_at, resolved_at, document, updated_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         blog_id = EXCLUDED.blog_id,
         article_id = EXCLUDED.article_id,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         resolved_at = EXCLUDED.resolved_at,
         document = EXCLUDED.document,
         updated_at = now()`,
      [approval.id, approval.blogId, approval.articleId ?? null, approval.status ?? 'pending', approval.createdAt, approval.resolvedAt ?? null, JSON.stringify(approval)],
    )
  }

  async #trim(client, table, orderColumn, keep) {
    await client.query(
      `DELETE FROM ${table}
       WHERE id IN (
         SELECT id FROM ${table}
         ORDER BY ${orderColumn} DESC, id DESC
         OFFSET $1
       )`,
      [keep],
    )
  }

  async read() {
    const [state, ideas, articles, approvals] = await Promise.all([
      super.read(),
      this.ideaList({ limit: 3000 }),
      this.articleList({ limit: 5000 }),
      this.approvalList({ limit: 3000 }),
    ])
    state.ideas = ideas
    state.articles = articles
    state.approvals = approvals
    return state
  }

  async ideaAppend(idea, { limit = 3000 } = {}) {
    if (!idea?.id) throw new Error('Idea id is required')
    if (!idea?.blogId) throw new Error('Idea blogId is required')
    if (!idea?.createdAt) throw new Error('Idea createdAt is required')
    const keep = safeLimit(limit, 3000, 30_000)
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      await this.#upsertIdea(client, idea)
      await this.#trim(client, 'bloggers_ideas', 'created_at', keep)
      await client.query('COMMIT')
      return structuredClone(idea)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async ideaList({ blogId = null, limit = 3000 } = {}) {
    const take = safeLimit(limit, 3000, 30_000)
    const params = blogId ? [blogId, take] : [take]
    const result = await this.#editorialPool.query(
      blogId
        ? `SELECT id, blog_id, created_at, document
           FROM bloggers_ideas
           WHERE blog_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`
        : `SELECT id, blog_id, created_at, document
           FROM bloggers_ideas
           ORDER BY created_at DESC, id DESC
           LIMIT $1`,
      params,
    )
    return (result.rows ?? []).map((row) => hydratedDocument(row))
  }

  async articleUpsert(article, { limit = 5000 } = {}) {
    if (!article?.id || !article?.blogId) throw new Error('Article id and blogId are required')
    const keep = safeLimit(limit, 5000, 50_000)
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      await this.#upsertArticle(client, article)
      await this.#trim(client, 'bloggers_articles', 'updated_at', keep)
      await client.query('COMMIT')
      return structuredClone(article)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async approvalUpsert(approval, { limit = 3000 } = {}) {
    if (!approval?.id || !approval?.blogId || !approval?.createdAt) throw new Error('Approval id, blogId and createdAt are required')
    const keep = safeLimit(limit, 3000, 30_000)
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      await this.#upsertApproval(client, approval)
      await this.#trim(client, 'bloggers_approvals', 'created_at', keep)
      await client.query('COMMIT')
      return structuredClone(approval)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async articleApprovalSave(article, approval, { articleLimit = 5000, approvalLimit = 3000 } = {}) {
    if (!article?.id || !approval?.id) throw new Error('Article and approval ids are required')
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      await this.#upsertArticle(client, article)
      await this.#upsertApproval(client, approval)
      await this.#trim(client, 'bloggers_articles', 'updated_at', safeLimit(articleLimit, 5000, 50_000))
      await this.#trim(client, 'bloggers_approvals', 'created_at', safeLimit(approvalLimit, 3000, 30_000))
      await client.query('COMMIT')
      return { article: structuredClone(article), approval: structuredClone(approval) }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async articleApprovalResolve({ approvalId, approvalPatch, articleId = null, articlePatch = null } = {}) {
    if (!approvalId) throw new Error('approvalId is required')
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      const approvalResult = await client.query(
        `SELECT id, blog_id, article_id, status, created_at, resolved_at, document
         FROM bloggers_approvals
         WHERE id = $1
         FOR UPDATE`,
        [approvalId],
      )
      if (!approvalResult.rows?.[0]) throw new Error('Approval not found')
      const approval = hydratedDocument(approvalResult.rows[0])
      mergePatch(approval, approvalPatch)
      await this.#upsertApproval(client, approval)

      let article = null
      if (articleId) {
        const articleResult = await client.query(
          `SELECT id, blog_id, idea_id, status, created_at, updated_at, document
           FROM bloggers_articles
           WHERE id = $1
           FOR UPDATE`,
          [articleId],
        )
        if (!articleResult.rows?.[0]) throw new Error('Article not found')
        article = hydratedDocument(articleResult.rows[0])
        mergePatch(article, articlePatch)
        await this.#upsertArticle(client, article)
      }

      await client.query('COMMIT')
      return { approval: structuredClone(approval), article: article ? structuredClone(article) : null }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async articleList({ blogId = null, limit = 5000 } = {}) {
    const take = safeLimit(limit, 5000, 50_000)
    const params = blogId ? [blogId, take] : [take]
    const result = await this.#editorialPool.query(
      blogId
        ? `SELECT id, blog_id, idea_id, status, created_at, updated_at, document
           FROM bloggers_articles
           WHERE blog_id = $1
           ORDER BY updated_at DESC, id DESC
           LIMIT $2`
        : `SELECT id, blog_id, idea_id, status, created_at, updated_at, document
           FROM bloggers_articles
           ORDER BY updated_at DESC, id DESC
           LIMIT $1`,
      params,
    )
    return (result.rows ?? []).map((row) => hydratedDocument(row))
  }

  async approvalList({ blogId = null, status = null, limit = 3000 } = {}) {
    const take = safeLimit(limit, 3000, 30_000)
    const clauses = []
    const params = []
    if (blogId) {
      params.push(blogId)
      clauses.push(`blog_id = $${params.length}`)
    }
    if (status) {
      params.push(status)
      clauses.push(`status = $${params.length}`)
    }
    params.push(take)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const result = await this.#editorialPool.query(
      `SELECT id, blog_id, article_id, status, created_at, resolved_at, document
       FROM bloggers_approvals
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    )
    return (result.rows ?? []).map((row) => hydratedDocument(row))
  }
}
