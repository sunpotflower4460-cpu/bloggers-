// @feature F-006
// @feature F-008
// @feature F-012
import { PostgresConfigStore } from './postgres-config-store.js'
import { DEFAULT_STATE } from './store.js'
import { mergeSystemSections, splitSystemSections, SYSTEM_SECTIONS } from './system-store.js'

const STATE_KEY = 'global'

function decodeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

function clone(value) {
  return structuredClone(value)
}

function assertSection(section) {
  if (!SYSTEM_SECTIONS.includes(section)) throw new Error(`Unsupported system section: ${section}`)
}

function nonSystemFingerprint(state) {
  const snapshot = clone(state)
  delete snapshot.system
  return JSON.stringify(snapshot)
}

function revisionConflict(section, expectedRevision, currentRevision) {
  const error = new Error(`${section} settings changed in another session. Reload the latest settings before saving.`)
  error.code = 'SYSTEM_VERSION_CONFLICT'
  error.status = 409
  error.section = section
  error.expectedRevision = expectedRevision
  error.currentRevision = currentRevision
  return error
}

export class PostgresSystemStore extends PostgresConfigStore {
  #systemPool

  constructor(pool) {
    super(pool)
    this.#systemPool = pool
  }

  get capabilities() {
    return {
      ...super.capabilities,
      nativeSystemSections: true,
      nativeSystemMutation: true,
      optimisticSystemRevision: true,
    }
  }

  async init() {
    await super.init()
    await this.#systemPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_system_settings (
        setting_key text PRIMARY KEY,
        document jsonb NOT NULL,
        revision bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#promoteLegacySystem()
    return this
  }

  async #promoteLegacySystem() {
    const client = await this.#systemPool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        'SELECT document, version FROM bloggers_state WHERE state_key = $1 FOR UPDATE',
        [STATE_KEY],
      )
      const rawState = clone(decodeJson(locked.rows?.[0]?.document) ?? {})
      const rawSystem = rawState.system
      const hasLegacySystem = rawSystem && typeof rawSystem === 'object' && Object.keys(rawSystem).length > 0

      if (hasLegacySystem) {
        const sections = splitSystemSections(rawSystem)
        for (const section of SYSTEM_SECTIONS) {
          await client.query(
            `INSERT INTO bloggers_system_settings (setting_key, document, revision, updated_at)
             VALUES ($1, $2::jsonb, 1, now())
             ON CONFLICT (setting_key) DO NOTHING`,
            [section, JSON.stringify(sections[section])],
          )
        }
        rawState.system = {}
        await client.query(
          `UPDATE bloggers_state
           SET document = $2::jsonb, version = $3, updated_at = now()
           WHERE state_key = $1`,
          [STATE_KEY, JSON.stringify(rawState), Number(rawState.version || locked.rows?.[0]?.version || DEFAULT_STATE.version)],
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

  async #ensureSection(queryable, section) {
    const defaults = splitSystemSections(DEFAULT_STATE.system)[section]
    await queryable.query(
      `INSERT INTO bloggers_system_settings (setting_key, document, revision, updated_at)
       VALUES ($1, $2::jsonb, 1, now())
       ON CONFLICT (setting_key) DO NOTHING`,
      [section, JSON.stringify(defaults)],
    )
  }

  async #lockAllSections(client) {
    const sections = {}
    for (const section of SYSTEM_SECTIONS) {
      await this.#ensureSection(client, section)
      const locked = await client.query(
        `SELECT document, revision
         FROM bloggers_system_settings
         WHERE setting_key = $1
         FOR UPDATE`,
        [section],
      )
      sections[section] = clone(decodeJson(locked.rows?.[0]?.document) ?? splitSystemSections(DEFAULT_STATE.system)[section])
    }
    return sections
  }

  async #writeSections(client, sections) {
    for (const section of SYSTEM_SECTIONS) {
      await client.query(
        `UPDATE bloggers_system_settings
         SET document = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE setting_key = $1`,
        [section, JSON.stringify(sections[section])],
      )
    }
  }

  async read() {
    const [state, rows] = await Promise.all([
      super.read(),
      this.#systemPool.query(
        `SELECT setting_key, document, revision, updated_at
         FROM bloggers_system_settings
         ORDER BY setting_key ASC`,
      ),
    ])
    const sections = {}
    for (const row of rows.rows ?? []) {
      if (!SYSTEM_SECTIONS.includes(row.setting_key)) continue
      sections[row.setting_key] = clone(decodeJson(row.document) ?? {})
    }
    state.system = mergeSystemSections(sections, state.system)
    return state
  }

  async mutate(mutator) {
    if (typeof mutator !== 'function') throw new Error('state mutator must be a function')
    const client = await this.#systemPool.connect()
    try {
      await client.query('BEGIN')
      const sections = await this.#lockAllSections(client)
      const state = await super.read()
      state.system = mergeSystemSections(sections, state.system)
      const before = nonSystemFingerprint(state)
      const value = await mutator(state)
      if (nonSystemFingerprint(state) !== before) {
        throw new Error('Direct PostgresSystemStore.mutate() may only change state.system; use the native collection store for other state')
      }
      const nextSections = splitSystemSections(state.system)
      await this.#writeSections(client, nextSections)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async systemRead(section) {
    return (await this.systemReadWithRevision(section)).value
  }

  async systemReadWithRevision(section) {
    assertSection(section)
    const defaults = splitSystemSections(DEFAULT_STATE.system)[section]
    const result = await this.#systemPool.query(
      `SELECT document, revision, updated_at
       FROM bloggers_system_settings
       WHERE setting_key = $1`,
      [section],
    )
    return {
      value: clone(decodeJson(result.rows?.[0]?.document) ?? defaults),
      revision: Number(result.rows?.[0]?.revision ?? 1),
      updatedAt: result.rows?.[0]?.updated_at ?? null,
    }
  }

  async systemMutate(section, mutator) {
    return this.#systemMutateLocked(section, null, mutator)
  }

  async systemMutateVersioned(section, expectedRevision, mutator) {
    return this.#systemMutateLocked(section, expectedRevision, mutator)
  }

  async #systemMutateLocked(section, expectedRevision, mutator) {
    assertSection(section)
    if (typeof mutator !== 'function') throw new Error('system mutator must be a function')
    const client = await this.#systemPool.connect()
    try {
      await client.query('BEGIN')
      await this.#ensureSection(client, section)
      const locked = await client.query(
        `SELECT document, revision
         FROM bloggers_system_settings
         WHERE setting_key = $1
         FOR UPDATE`,
        [section],
      )
      const currentRevision = Number(locked.rows?.[0]?.revision ?? 1)
      if (expectedRevision !== null && Number(expectedRevision) !== currentRevision) {
        throw revisionConflict(section, Number(expectedRevision), currentRevision)
      }
      const value = clone(decodeJson(locked.rows?.[0]?.document) ?? splitSystemSections(DEFAULT_STATE.system)[section])
      const result = await mutator(value)
      await client.query(
        `UPDATE bloggers_system_settings
         SET document = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE setting_key = $1`,
        [section, JSON.stringify(value)],
      )
      await client.query('COMMIT')
      return result === undefined ? clone(value) : result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async systemUpsert(section, document) {
    assertSection(section)
    const value = clone(document ?? splitSystemSections(DEFAULT_STATE.system)[section])
    await this.#systemPool.query(
      `INSERT INTO bloggers_system_settings (setting_key, document, revision, updated_at)
       VALUES ($1, $2::jsonb, 1, now())
       ON CONFLICT (setting_key) DO UPDATE SET
         document = EXCLUDED.document,
         revision = bloggers_system_settings.revision + 1,
         updated_at = now()`,
      [section, JSON.stringify(value)],
    )
    return clone(value)
  }
}
