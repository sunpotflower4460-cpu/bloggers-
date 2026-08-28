// @feature F-004
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

function ideaDocument(row) {
  const document = structuredClone(decodeJson(row.document) ?? {})
  document.id ??= row.id
  document.blogId ??= row.blog_id
  document.createdAt ??= iso(row.created_at)
  return document
}

function safeLimit(value, fallback = 3000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(30_000, Math.round(parsed)))
}

export class PostgresEditorialStore extends PostgresRuntimeStore {
  #editorialPool

  constructor(pool) {
    super(pool)
    this.#editorialPool = pool
  }

  get capabilities() {
    return { ...super.capabilities, nativeIdeas: true }
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
    await this.#promoteLegacyIdeas()
    return this
  }

  async #promoteLegacyIdeas() {
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        'SELECT document FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const state = normalizeState(decodeJson(locked.rows?.[0]?.document) ?? {})
      const legacy = Array.isArray(state.ideas) ? state.ideas : []
      if (legacy.length > 0) {
        for (const idea of legacy) {
          if (!idea?.id || !idea?.blogId || !idea?.createdAt) continue
          await client.query(
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
        state.ideas = []
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

  async read() {
    const [state, ideas] = await Promise.all([
      super.read(),
      this.ideaList({ limit: 3000 }),
    ])
    state.ideas = ideas
    return state
  }

  async ideaAppend(idea, { limit = 3000 } = {}) {
    if (!idea?.id) throw new Error('Idea id is required')
    if (!idea?.blogId) throw new Error('Idea blogId is required')
    if (!idea?.createdAt) throw new Error('Idea createdAt is required')
    const keep = safeLimit(limit)
    const client = await this.#editorialPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
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
      await client.query(
        `DELETE FROM bloggers_ideas
         WHERE id IN (
           SELECT id FROM bloggers_ideas
           ORDER BY created_at DESC, id DESC
           OFFSET $1
         )`,
        [keep],
      )
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
    const take = safeLimit(limit)
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
    return (result.rows ?? []).map(ideaDocument)
  }
}
