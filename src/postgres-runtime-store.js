// @feature F-007
// @feature F-009
// @feature F-012
import { PostgresStore } from './postgres-store.js'
import { normalizeState } from './store.js'

const STATE_KEY = 'global'

function iso(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function decodeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

function analyticsDocument(row) {
  const document = structuredClone(decodeJson(row.document) ?? {})
  document.id ??= row.id
  document.blogId ??= row.blog_id
  document.capturedAt ??= iso(row.captured_at)
  return document
}

function activityDocument(row) {
  const document = structuredClone(decodeJson(row.document) ?? {})
  document.id ??= row.id
  document.blogId ??= row.blog_id ?? null
  document.createdAt ??= iso(row.created_at)
  return document
}

function safeLimit(value, fallback = 5000, max = 50_000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.round(parsed)))
}

export class PostgresRuntimeStore extends PostgresStore {
  #runtimePool

  constructor(pool) {
    super(pool)
    this.#runtimePool = pool
  }

  get capabilities() {
    return {
      ...super.capabilities,
      nativeLeaseRenew: true,
      nativeAnalytics: true,
      nativeActivities: true,
    }
  }

  async init() {
    await super.init()
    await this.#runtimePool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_analytics (
        id text PRIMARY KEY,
        blog_id text NOT NULL,
        captured_at timestamptz NOT NULL,
        document jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#runtimePool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_analytics_blog_time_idx
      ON bloggers_analytics (blog_id, captured_at DESC)
    `)
    await this.#runtimePool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_analytics_time_idx
      ON bloggers_analytics (captured_at DESC)
    `)
    await this.#runtimePool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_activities (
        id text PRIMARY KEY,
        blog_id text,
        created_at timestamptz NOT NULL,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#runtimePool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_activities_blog_time_idx
      ON bloggers_activities (blog_id, created_at DESC)
    `)
    await this.#runtimePool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_activities_time_idx
      ON bloggers_activities (created_at DESC)
    `)
    await this.#promoteLegacyCollections()
    return this
  }

  async #promoteLegacyCollections() {
    const client = await this.#runtimePool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        'SELECT document FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const raw = decodeJson(locked.rows?.[0]?.document) ?? {}
      const state = normalizeState(raw)
      const legacyAnalytics = Array.isArray(state.analytics) ? state.analytics : []
      const legacyActivities = Array.isArray(state.activities) ? state.activities : []
      let changed = false

      if (legacyAnalytics.length > 0) {
        for (const snapshot of legacyAnalytics) {
          if (!snapshot?.id || !snapshot?.blogId || !snapshot?.capturedAt) continue
          await client.query(
            `INSERT INTO bloggers_analytics
               (id, blog_id, captured_at, document, created_at, updated_at)
             VALUES ($1, $2, $3::timestamptz, $4::jsonb, now(), now())
             ON CONFLICT (id) DO UPDATE SET
               blog_id = EXCLUDED.blog_id,
               captured_at = EXCLUDED.captured_at,
               document = EXCLUDED.document,
               updated_at = now()`,
            [snapshot.id, snapshot.blogId, snapshot.capturedAt, JSON.stringify(snapshot)],
          )
        }
        state.analytics = []
        changed = true
      }

      if (legacyActivities.length > 0) {
        for (const activity of legacyActivities) {
          if (!activity?.id || !activity?.createdAt) continue
          await client.query(
            `INSERT INTO bloggers_activities
               (id, blog_id, created_at, document, updated_at)
             VALUES ($1, $2, $3::timestamptz, $4::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET
               blog_id = EXCLUDED.blog_id,
               created_at = EXCLUDED.created_at,
               document = EXCLUDED.document,
               updated_at = now()`,
            [activity.id, activity.blogId ?? null, activity.createdAt, JSON.stringify(activity)],
          )
        }
        state.activities = []
        changed = true
      }

      if (changed) {
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
    const [state, analytics, activities] = await Promise.all([
      super.read(),
      this.analyticsList({ limit: 5000 }),
      this.activityList({ limit: 1000 }),
    ])
    state.analytics = analytics
    state.activities = activities
    return state
  }

  async analyticsAppend(snapshot, { limit = 5000 } = {}) {
    if (!snapshot?.id) throw new Error('Analytics snapshot id is required')
    if (!snapshot?.blogId) throw new Error('Analytics snapshot blogId is required')
    if (!snapshot?.capturedAt) throw new Error('Analytics snapshot capturedAt is required')
    const keep = safeLimit(limit)
    const client = await this.#runtimePool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO bloggers_analytics
           (id, blog_id, captured_at, document, created_at, updated_at)
         VALUES ($1, $2, $3::timestamptz, $4::jsonb, now(), now())
         ON CONFLICT (id) DO UPDATE SET
           blog_id = EXCLUDED.blog_id,
           captured_at = EXCLUDED.captured_at,
           document = EXCLUDED.document,
           updated_at = now()`,
        [snapshot.id, snapshot.blogId, snapshot.capturedAt, JSON.stringify(snapshot)],
      )
      await client.query(
        `DELETE FROM bloggers_analytics
         WHERE id IN (
           SELECT id FROM bloggers_analytics
           ORDER BY captured_at DESC, id DESC
           OFFSET $1
         )`,
        [keep],
      )
      await client.query('COMMIT')
      return structuredClone(snapshot)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async analyticsList({ blogId = null, limit = 5000 } = {}) {
    const take = safeLimit(limit)
    const params = blogId ? [blogId, take] : [take]
    const result = await this.#runtimePool.query(
      blogId
        ? `SELECT id, blog_id, captured_at, document
           FROM bloggers_analytics
           WHERE blog_id = $1
           ORDER BY captured_at DESC, id DESC
           LIMIT $2`
        : `SELECT id, blog_id, captured_at, document
           FROM bloggers_analytics
           ORDER BY captured_at DESC, id DESC
           LIMIT $1`,
      params,
    )
    return (result.rows ?? []).map(analyticsDocument)
  }

  async activityAppend(activity, { limit = 1000 } = {}) {
    if (!activity?.id) throw new Error('Activity id is required')
    if (!activity?.createdAt) throw new Error('Activity createdAt is required')
    const keep = safeLimit(limit, 1000, 20_000)
    const client = await this.#runtimePool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO bloggers_activities
           (id, blog_id, created_at, document, updated_at)
         VALUES ($1, $2, $3::timestamptz, $4::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           blog_id = EXCLUDED.blog_id,
           created_at = EXCLUDED.created_at,
           document = EXCLUDED.document,
           updated_at = now()`,
        [activity.id, activity.blogId ?? null, activity.createdAt, JSON.stringify(activity)],
      )
      await client.query(
        `DELETE FROM bloggers_activities
         WHERE id IN (
           SELECT id FROM bloggers_activities
           ORDER BY created_at DESC, id DESC
           OFFSET $1
         )`,
        [keep],
      )
      await client.query('COMMIT')
      return structuredClone(activity)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async activityList({ blogId = null, limit = 1000 } = {}) {
    const take = safeLimit(limit, 1000, 20_000)
    const params = blogId ? [blogId, take] : [take]
    const result = await this.#runtimePool.query(
      blogId
        ? `SELECT id, blog_id, created_at, document
           FROM bloggers_activities
           WHERE blog_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`
        : `SELECT id, blog_id, created_at, document
           FROM bloggers_activities
           ORDER BY created_at DESC, id DESC
           LIMIT $1`,
      params,
    )
    return (result.rows ?? []).map(activityDocument)
  }

  async leaseRenew(key, owner, { ttlMs, now = Date.now() } = {}) {
    if (!owner) throw new Error('Operation lease renewal requires an owner')
    const duration = Math.max(1000, Number(ttlMs || 0))
    const updatedAt = new Date(now).toISOString()
    const expiresAt = new Date(now + duration).toISOString()
    const result = await this.#runtimePool.query(
      `UPDATE bloggers_operation_leases
       SET expires_at = $4::timestamptz, updated_at = $3::timestamptz
       WHERE lease_key = $1 AND owner = $2 AND expires_at > $3::timestamptz
       RETURNING lease_key, lease_id, owner, acquired_at, expires_at, updated_at`,
      [key, owner, updatedAt, expiresAt],
    )
    const row = result.rows?.[0]
    if (!row) {
      const error = new Error(`Operation lease ownership was lost: ${key}`)
      error.code = 'OPERATION_LEASE_LOST'
      throw error
    }
    return {
      id: row.lease_id,
      key: row.lease_key,
      owner: row.owner,
      acquiredAt: iso(row.acquired_at),
      expiresAt: iso(row.expires_at),
      updatedAt: iso(row.updated_at),
    }
  }
}
