// @feature F-012
import { assertPersistableSecretReferences } from './secrets.js'
import { DEFAULT_STATE, normalizeState } from './store.js'

const STATE_KEY = 'global'

function decodeDocument(value) {
  if (!value) return structuredClone(DEFAULT_STATE)
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

export class PostgresStore {
  #pool

  constructor(pool) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('PostgresStore requires a pool with connect()')
    this.#pool = pool
  }

  get backend() {
    return 'postgres'
  }

  async init() {
    const client = await this.#pool.connect()
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS bloggers_state (
          state_key text PRIMARY KEY,
          version integer NOT NULL,
          document jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await client.query(
        `INSERT INTO bloggers_state (state_key, version, document)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (state_key) DO NOTHING`,
        [STATE_KEY, DEFAULT_STATE.version, JSON.stringify(DEFAULT_STATE)],
      )
    } finally {
      client.release?.()
    }
    return this
  }

  async read() {
    const result = await this.#pool.query(
      'SELECT document FROM bloggers_state WHERE state_key = $1',
      [STATE_KEY],
    )
    return normalizeState(decodeDocument(result.rows?.[0]?.document))
  }

  async mutate(mutator) {
    return this.transaction(mutator)
  }

  async transaction(mutator) {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        'SELECT document FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const state = normalizeState(decodeDocument(result.rows?.[0]?.document))
      const value = await mutator(state)
      assertPersistableSecretReferences(state)
      await client.query(
        `UPDATE bloggers_state
         SET version = $2, document = $3::jsonb, updated_at = now()
         WHERE state_key = $1`,
        [STATE_KEY, Number(state.version || DEFAULT_STATE.version), JSON.stringify(state)],
      )
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }
}
