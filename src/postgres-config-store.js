// @feature F-002
// @feature F-012
import { PostgresLearningStore } from './postgres-learning-store.js'
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

function hydrateBlog(row) {
  const blog = structuredClone(decodeJson(row.document) ?? {})
  blog.id ??= row.id
  blog.slug ??= row.slug
  blog.active ??= Boolean(row.active)
  blog.createdAt ??= iso(row.created_at)
  blog.updatedAt ??= iso(row.updated_at)
  return blog
}

function safeLimit(value, fallback = 1000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(10_000, Math.round(parsed)))
}

function translateUniqueError(error) {
  if (error?.code !== '23505') return error
  const translated = new Error('A blog with this slug already exists')
  translated.code = 'BLOG_ALREADY_EXISTS'
  translated.cause = error
  return translated
}

export class PostgresConfigStore extends PostgresLearningStore {
  #configPool

  constructor(pool) {
    super(pool)
    this.#configPool = pool
  }

  get capabilities() {
    return {
      ...super.capabilities,
      nativeBlogs: true,
      nativeBlogMutation: true,
    }
  }

  async init() {
    await super.init()
    await this.#configPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_blogs (
        id text PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        document jsonb NOT NULL
      )
    `)
    await this.#configPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_blogs_active_updated_idx
      ON bloggers_blogs (active, updated_at DESC)
    `)
    await this.#promoteLegacyBlogs()
    return this
  }

  async #promoteLegacyBlogs() {
    const client = await this.#configPool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        'SELECT document FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const state = normalizeState(decodeJson(locked.rows?.[0]?.document) ?? {})
      const legacy = Array.isArray(state.blogs) ? state.blogs : []
      const remaining = []
      let migrated = 0

      for (const blog of legacy) {
        if (!blog?.id || !blog?.slug || !blog?.createdAt) {
          remaining.push(blog)
          continue
        }
        await this.#upsertBlog(client, blog)
        migrated += 1
      }

      if (migrated > 0) {
        state.blogs = remaining
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
      throw translateUniqueError(error)
    } finally {
      client.release?.()
    }
  }

  async #upsertBlog(queryable, blog) {
    const createdAt = blog.createdAt ?? blog.updatedAt ?? new Date().toISOString()
    const updatedAt = blog.updatedAt ?? createdAt
    await queryable.query(
      `INSERT INTO bloggers_blogs
         (id, slug, active, created_at, updated_at, document)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         slug = EXCLUDED.slug,
         active = EXCLUDED.active,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         document = EXCLUDED.document`,
      [blog.id, blog.slug, blog.active !== false, createdAt, updatedAt, JSON.stringify(blog)],
    )
  }

  async read() {
    const [state, blogs] = await Promise.all([
      super.read(),
      this.blogList({ limit: 1000 }),
    ])
    state.blogs = blogs
    return state
  }

  async blogCreate(blog) {
    if (!blog?.id || !blog?.slug) throw new Error('Blog id and slug are required')
    const createdAt = blog.createdAt ?? blog.updatedAt ?? new Date().toISOString()
    const updatedAt = blog.updatedAt ?? createdAt
    try {
      await this.#configPool.query(
        `INSERT INTO bloggers_blogs
           (id, slug, active, created_at, updated_at, document)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)`,
        [blog.id, blog.slug, blog.active !== false, createdAt, updatedAt, JSON.stringify(blog)],
      )
      return structuredClone(blog)
    } catch (error) {
      throw translateUniqueError(error)
    }
  }

  async blogUpsert(blog) {
    if (!blog?.id || !blog?.slug) throw new Error('Blog id and slug are required')
    const client = await this.#configPool.connect()
    try {
      await client.query('BEGIN')
      await this.#upsertBlog(client, blog)
      await client.query('COMMIT')
      return structuredClone(blog)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw translateUniqueError(error)
    } finally {
      client.release?.()
    }
  }

  async blogMutate(blogId, mutator) {
    if (!blogId) throw new Error('blogId is required')
    if (typeof mutator !== 'function') throw new Error('blog mutator must be a function')
    const client = await this.#configPool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `SELECT id, slug, active, created_at, updated_at, document
         FROM bloggers_blogs
         WHERE id = $1
         FOR UPDATE`,
        [blogId],
      )
      if (!result.rows?.[0]) throw new Error('Blog not found')
      const blog = hydrateBlog(result.rows[0])
      const value = await mutator(blog)
      if (blog.id !== blogId) throw new Error('Blog id cannot be changed')
      if (!blog.slug) throw new Error('Blog slug is required')
      await this.#upsertBlog(client, blog)
      await client.query('COMMIT')
      return value === undefined ? structuredClone(blog) : value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw translateUniqueError(error)
    } finally {
      client.release?.()
    }
  }

  async blogList({ active = null, limit = 1000 } = {}) {
    const take = safeLimit(limit)
    const params = []
    let where = ''
    if (active !== null) {
      params.push(Boolean(active))
      where = `WHERE active = $${params.length}`
    }
    params.push(take)
    const result = await this.#configPool.query(
      `SELECT id, slug, active, created_at, updated_at, document
       FROM bloggers_blogs
       ${where}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
      params,
    )
    return (result.rows ?? []).map(hydrateBlog)
  }
}
