// @feature F-001
// @feature F-006
// @feature F-009
// @feature F-012
import { PostgresSystemStore } from './postgres-system-store.js'

const CONTROL_KEY = 'global'
const MAX_SESSIONS = 2000
const ROLES = new Set(['viewer', 'editor', 'admin'])

function decodeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return JSON.parse(value)
  return value
}

function clone(value) {
  return structuredClone(value)
}

function normalizeRegistry(value = {}) {
  return {
    version: 1,
    generation: Math.max(1, Number(value?.generation || 1)),
    sessions: value?.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
      ? clone(value.sessions)
      : {},
  }
}

function validFingerprint(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''))
}

function normalizeSession(fingerprint, session = {}) {
  const issuedAt = Number(session.issuedAt)
  const expiresAt = Number(session.expiresAt)
  const revokedAt = session.revokedAt === null || session.revokedAt === undefined
    ? null
    : Number(session.revokedAt)
  if (!validFingerprint(fingerprint) || !session.principalId || !ROLES.has(session.role)) return null
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return null
  if (revokedAt !== null && !Number.isFinite(revokedAt)) return null
  return {
    fingerprint,
    principalId: String(session.principalId),
    subject: session.subject ?? null,
    issuer: session.issuer ?? null,
    role: session.role,
    issuedAt,
    expiresAt,
    revokedAt,
    revokedBy: session.revokedBy ?? null,
  }
}

export class PostgresSessionStore extends PostgresSystemStore {
  #sessionPool

  constructor(pool) {
    super(pool)
    this.#sessionPool = pool
  }

  get capabilities() {
    return {
      ...super.capabilities,
      nativeOidcSessions: true,
    }
  }

  async init() {
    await super.init()
    await this.#sessionPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_oidc_session_control (
        control_key text PRIMARY KEY,
        generation bigint NOT NULL DEFAULT 1,
        revoked_all_at bigint,
        revoked_all_by text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#sessionPool.query(`
      CREATE TABLE IF NOT EXISTS bloggers_oidc_sessions (
        fingerprint text PRIMARY KEY,
        principal_id text NOT NULL,
        subject text,
        issuer text,
        role text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
        issued_at bigint NOT NULL,
        expires_at bigint NOT NULL,
        revoked_at bigint,
        revoked_by text,
        generation bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await this.#sessionPool.query(`
      CREATE INDEX IF NOT EXISTS bloggers_oidc_sessions_expiry_idx
      ON bloggers_oidc_sessions (expires_at)
    `)
    await this.#ensureControl(this.#sessionPool)
    await this.#promoteLegacyRegistry()
    return this
  }

  async #ensureControl(queryable) {
    await queryable.query(
      `INSERT INTO bloggers_oidc_session_control (control_key, generation, updated_at)
       VALUES ($1, 1, now())
       ON CONFLICT (control_key) DO NOTHING`,
      [CONTROL_KEY],
    )
  }

  async #promoteLegacyRegistry() {
    const client = await this.#sessionPool.connect()
    try {
      await client.query('BEGIN')
      await this.#ensureControl(client)
      const locked = await client.query(
        `SELECT document, revision
         FROM bloggers_system_settings
         WHERE setting_key = 'core'
         FOR UPDATE`,
      )
      const core = clone(decodeJson(locked.rows?.[0]?.document) ?? {})
      if (!core.oidcSessions) {
        await client.query('COMMIT')
        return
      }

      const registry = normalizeRegistry(core.oidcSessions)
      await client.query(
        `UPDATE bloggers_oidc_session_control
         SET generation = GREATEST(generation, $2), updated_at = now()
         WHERE control_key = $1`,
        [CONTROL_KEY, registry.generation],
      )
      for (const [fingerprint, rawSession] of Object.entries(registry.sessions)) {
        const session = normalizeSession(fingerprint, rawSession)
        if (!session) continue
        await this.#upsertSession(client, session, registry.generation)
      }

      delete core.oidcSessions
      await client.query(
        `UPDATE bloggers_system_settings
         SET document = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE setting_key = $1`,
        ['core', JSON.stringify(core)],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async #upsertSession(queryable, session, generation) {
    await queryable.query(
      `INSERT INTO bloggers_oidc_sessions (
         fingerprint, principal_id, subject, issuer, role, issued_at, expires_at,
         revoked_at, revoked_by, generation, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
       ON CONFLICT (fingerprint) DO UPDATE SET
         principal_id = EXCLUDED.principal_id,
         subject = EXCLUDED.subject,
         issuer = EXCLUDED.issuer,
         role = EXCLUDED.role,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         revoked_at = EXCLUDED.revoked_at,
         revoked_by = EXCLUDED.revoked_by,
         generation = EXCLUDED.generation,
         updated_at = now()`,
      [
        session.fingerprint,
        session.principalId,
        session.subject,
        session.issuer,
        session.role,
        session.issuedAt,
        session.expiresAt,
        session.revokedAt,
        session.revokedBy,
        generation,
      ],
    )
  }

  async oidcSessionRegister(session, { now }) {
    const normalized = normalizeSession(session?.fingerprint, session)
    if (!normalized) throw new Error('Invalid OIDC session registration record')
    const client = await this.#sessionPool.connect()
    try {
      await client.query('BEGIN')
      await this.#ensureControl(client)
      const control = await client.query(
        `SELECT generation
         FROM bloggers_oidc_session_control
         WHERE control_key = $1
         FOR UPDATE`,
        [CONTROL_KEY],
      )
      const generation = Math.max(1, Number(control.rows?.[0]?.generation ?? 1))
      await client.query('DELETE FROM bloggers_oidc_sessions WHERE expires_at <= $1', [Number(now)])
      await this.#upsertSession(client, normalized, generation)
      await client.query(
        `DELETE FROM bloggers_oidc_sessions
         WHERE fingerprint IN (
           SELECT fingerprint
           FROM bloggers_oidc_sessions
           ORDER BY issued_at DESC, fingerprint DESC
           OFFSET $1
         )`,
        [MAX_SESSIONS],
      )
      await client.query('COMMIT')
      return { fingerprint: normalized.fingerprint, expiresAt: normalized.expiresAt, generation }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async oidcSessionActive({ fingerprint, principalId, now }) {
    if (!validFingerprint(fingerprint) || !principalId) return false
    const result = await this.#sessionPool.query(
      `SELECT fingerprint
       FROM bloggers_oidc_sessions
       WHERE fingerprint = $1
         AND principal_id = $2
         AND revoked_at IS NULL
         AND expires_at > $3
       LIMIT 1`,
      [fingerprint, String(principalId), Number(now)],
    )
    return Boolean(result.rows?.length)
  }

  async oidcSessionRevoke({ fingerprint, actor = null, now }) {
    if (!validFingerprint(fingerprint)) return { revoked: false, reason: 'session-not-registered' }
    const result = await this.#sessionPool.query(
      `UPDATE bloggers_oidc_sessions
       SET revoked_at = $2, revoked_by = $3, updated_at = now()
       WHERE fingerprint = $1
         AND expires_at > $2
         AND revoked_at IS NULL
       RETURNING fingerprint, revoked_at`,
      [fingerprint, Number(now), actor],
    )
    if (!result.rows?.length) return { revoked: false, reason: 'session-not-registered' }
    return { revoked: true, fingerprint, revokedAt: Number(result.rows[0].revoked_at ?? now) }
  }

  async oidcSessionsRevokeAll({ actor = null, now }) {
    const client = await this.#sessionPool.connect()
    try {
      await client.query('BEGIN')
      await this.#ensureControl(client)
      const control = await client.query(
        `SELECT generation
         FROM bloggers_oidc_session_control
         WHERE control_key = $1
         FOR UPDATE`,
        [CONTROL_KEY],
      )
      const previousGeneration = Math.max(1, Number(control.rows?.[0]?.generation ?? 1))
      const count = await client.query(
        `SELECT count(*) AS active
         FROM bloggers_oidc_sessions
         WHERE revoked_at IS NULL AND expires_at > $1`,
        [Number(now)],
      )
      const revokedCount = Number(count.rows?.[0]?.active ?? 0)
      await client.query('DELETE FROM bloggers_oidc_sessions')
      const nextGeneration = previousGeneration + 1
      await client.query(
        `UPDATE bloggers_oidc_session_control
         SET generation = $2, revoked_all_at = $3, revoked_all_by = $4, updated_at = now()
         WHERE control_key = $1`,
        [CONTROL_KEY, nextGeneration, Number(now), actor],
      )
      await client.query('COMMIT')
      return { revokedCount, generation: nextGeneration, revokedAt: Number(now) }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async oidcSessionSummary({ now }) {
    await this.#ensureControl(this.#sessionPool)
    const [control, counts] = await Promise.all([
      this.#sessionPool.query(
        'SELECT generation FROM bloggers_oidc_session_control WHERE control_key = $1',
        [CONTROL_KEY],
      ),
      this.#sessionPool.query(
        `SELECT
           count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > $1) AS active,
           count(*) FILTER (WHERE revoked_at IS NOT NULL AND expires_at > $1) AS revoked
         FROM bloggers_oidc_sessions`,
        [Number(now)],
      ),
    ])
    return {
      generation: Math.max(1, Number(control.rows?.[0]?.generation ?? 1)),
      active: Number(counts.rows?.[0]?.active ?? 0),
      revoked: Number(counts.rows?.[0]?.revoked ?? 0),
    }
  }

  async oidcSessionImportRegistry(value = {}) {
    const registry = normalizeRegistry(value)
    const client = await this.#sessionPool.connect()
    try {
      await client.query('BEGIN')
      await this.#ensureControl(client)
      await client.query(
        `UPDATE bloggers_oidc_session_control
         SET generation = GREATEST(generation, $2), updated_at = now()
         WHERE control_key = $1`,
        [CONTROL_KEY, registry.generation],
      )
      for (const [fingerprint, rawSession] of Object.entries(registry.sessions)) {
        const session = normalizeSession(fingerprint, rawSession)
        if (session) await this.#upsertSession(client, session, registry.generation)
      }
      await client.query('COMMIT')
      return { imported: Object.keys(registry.sessions).length, generation: registry.generation }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release?.()
    }
  }

  async systemUpsert(section, document) {
    if (section !== 'core' || !document?.oidcSessions) return super.systemUpsert(section, document)
    const core = clone(document)
    const registry = core.oidcSessions
    delete core.oidcSessions
    const result = await super.systemUpsert(section, core)
    await this.oidcSessionImportRegistry(registry)
    return result
  }
}
