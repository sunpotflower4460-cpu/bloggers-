// @feature F-011
// @feature F-012
import { PostgresEditorialStore } from './postgres-editorial-store.js'
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

function hydrate(row) {
  const document = structuredClone(decodeJson(row.document) ?? {})
  document.id ??= row.id
  document.blogId ??= row.blog_id ?? null
  return document
}

function safeLimit(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.round(parsed)))
}

export class PostgresLearningStore extends PostgresEditorialStore {
  #learningPool

  constructor(pool) {
    super(pool)
    this.#learningPool = pool
  }

  get capabilities() {
    return {
      ...super.capabilities,
      nativeExperiments: true,
      nativeMemories: true,
      nativeExperimentMemoryTransaction: true,
    }
  }

  async init() {
    await super.init()
    await this.#learningPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_experiments (
        id text PRIMARY KEY,
        blog_id text NOT NULL,
        article_id text,
        action text NOT NULL,
        status text NOT NULL,
        created_at timestamptz NOT NULL,
        completed_at timestamptz,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#learningPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_experiments_blog_status_idx
      ON bloggers_experiments (blog_id, status, created_at DESC)
    `)
    await this.#learningPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS bloggers_experiments_article_action_idx
      ON bloggers_experiments (article_id, action)
      WHERE article_id IS NOT NULL
    `)

    await this.#learningPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_memories (
        id text PRIMARY KEY,
        blog_id text,
        scope text NOT NULL,
        type text NOT NULL,
        source_experiment_id text,
        created_at timestamptz NOT NULL,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#learningPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_memories_blog_type_idx
      ON bloggers_memories (blog_id, type, created_at DESC)
    `)
    await this.#learningPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS bloggers_memories_source_experiment_idx
      ON bloggers_memories (source_experiment_id)
      WHERE source_experiment_id IS NOT NULL
    `)

    await this.#promoteLegacyLearning()
    return this
  }

  async #promoteLegacyLearning() {
    const client = await this.#learningPool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        'SELECT document FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const state = normalizeState(decodeJson(locked.rows?.[0]?.document) ?? {})
      const experiments = Array.isArray(state.experiments) ? state.experiments : []
      const memories = Array.isArray(state.memories) ? state.memories : []
      let changed = false

      for (const experiment of experiments) {
        if (!experiment?.id || !experiment?.blogId || !experiment?.createdAt) continue
        await this.#upsertExperiment(client, experiment)
        changed = true
      }
      for (const memory of memories) {
        if (!memory?.id || !memory?.createdAt) continue
        await this.#upsertMemory(client, memory)
        changed = true
      }

      if (changed) {
        state.experiments = []
        state.memories = []
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

  async #upsertExperiment(queryable, experiment) {
    await queryable.query(
      `INSERT INTO bloggers_experiments
         (id, blog_id, article_id, action, status, created_at, completed_at, document, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         blog_id = EXCLUDED.blog_id,
         article_id = EXCLUDED.article_id,
         action = EXCLUDED.action,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         completed_at = EXCLUDED.completed_at,
         document = EXCLUDED.document,
         updated_at = now()`,
      [
        experiment.id,
        experiment.blogId,
        experiment.articleId ?? null,
        experiment.action ?? 'UNKNOWN',
        experiment.status ?? 'running',
        experiment.createdAt,
        experiment.completedAt ?? null,
        JSON.stringify(experiment),
      ],
    )
  }

  async #upsertMemory(queryable, memory) {
    await queryable.query(
      `INSERT INTO bloggers_memories
         (id, blog_id, scope, type, source_experiment_id, created_at, document, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         blog_id = EXCLUDED.blog_id,
         scope = EXCLUDED.scope,
         type = EXCLUDED.type,
         source_experiment_id = EXCLUDED.source_experiment_id,
         created_at = EXCLUDED.created_at,
         document = EXCLUDED.document,
         updated_at = now()`,
      [
        memory.id,
        memory.blogId ?? null,
        memory.scope ?? 'blog',
        memory.type ?? 'memory',
        memory.sourceExperimentId ?? null,
        memory.createdAt,
        JSON.stringify(memory),
      ],
    )
  }

  async #trim(client, table, keep) {
    await client.query(
      `DELETE FROM ${table}
       WHERE id IN (
         SELECT id FROM ${table}
         ORDER BY created_at DESC, id DESC
         OFFSET $1
       )`,
      [keep],
    )
  }

  async read() {
    const [state, experiments, memories] = await Promise.all([
      super.read(),
      this.experimentList({ limit: 5000 }),
      this.memoryList({ limit: 2000 }),
    ])
    state.experiments = experiments
    state.memories = memories
    return state
  }

  async experimentMemoryTransaction(blogId, mutator) {
    if (!blogId) throw new Error('blogId is required for experiment/memory transaction')
    const client = await this.#learningPool.connect()
    try {
      await client.query('BEGIN')
      const experimentRows = await client.query(
        `SELECT id, blog_id, article_id, action, status, created_at, completed_at, document
         FROM bloggers_experiments
         WHERE blog_id = $1
         ORDER BY created_at DESC, id DESC
         FOR UPDATE`,
        [blogId],
      )
      const memoryRows = await client.query(
        `SELECT id, blog_id, scope, type, source_experiment_id, created_at, document
         FROM bloggers_memories
         WHERE blog_id = $1
         ORDER BY created_at DESC, id DESC
         FOR UPDATE`,
        [blogId],
      )
      const experiments = (experimentRows.rows ?? []).map(hydrate)
      const memories = (memoryRows.rows ?? []).map(hydrate)
      const value = await mutator({ experiments, memories })

      for (const experiment of experiments) await this.#upsertExperiment(client, experiment)
      for (const memory of memories) await this.#upsertMemory(client, memory)
      await this.#trim(client, 'bloggers_experiments', safeLimit(5000, 5000, 50_000))
      await this.#trim(client, 'bloggers_memories', safeLimit(2000, 2000, 20_000))
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async experimentUpsert(experiment) {
    const client = await this.#learningPool.connect()
    try {
      await client.query('BEGIN')
      await this.#upsertExperiment(client, experiment)
      await this.#trim(client, 'bloggers_experiments', 5000)
      await client.query('COMMIT')
      return structuredClone(experiment)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async memoryUpsert(memory) {
    const client = await this.#learningPool.connect()
    try {
      await client.query('BEGIN')
      await this.#upsertMemory(client, memory)
      await this.#trim(client, 'bloggers_memories', 2000)
      await client.query('COMMIT')
      return structuredClone(memory)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async experimentList({ blogId = null, limit = 5000 } = {}) {
    const take = safeLimit(limit, 5000, 50_000)
    const params = blogId ? [blogId, take] : [take]
    const result = await this.#learningPool.query(
      blogId
        ? `SELECT id, blog_id, article_id, action, status, created_at, completed_at, document
           FROM bloggers_experiments
           WHERE blog_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`
        : `SELECT id, blog_id, article_id, action, status, created_at, completed_at, document
           FROM bloggers_experiments
           ORDER BY created_at DESC, id DESC
           LIMIT $1`,
      params,
    )
    return (result.rows ?? []).map(hydrate)
  }

  async memoryList({ blogId = null, limit = 2000 } = {}) {
    const take = safeLimit(limit, 2000, 20_000)
    const params = blogId ? [blogId, take] : [take]
    const result = await this.#learningPool.query(
      blogId
        ? `SELECT id, blog_id, scope, type, source_experiment_id, created_at, document
           FROM bloggers_memories
           WHERE blog_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`
        : `SELECT id, blog_id, scope, type, source_experiment_id, created_at, document
           FROM bloggers_memories
           ORDER BY created_at DESC, id DESC
           LIMIT $1`,
      params,
    )
    return (result.rows ?? []).map(hydrate)
  }
}
