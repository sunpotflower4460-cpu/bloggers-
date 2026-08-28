// @feature F-001
// @feature F-006
// @feature F-009
// @feature F-012
import { createHash } from 'node:crypto'
import { mutateSystemSection, readSystemSection } from './system-store.js'

const SESSION_COOKIE_NAMES = ['__Host-bloggers_session', 'bloggers_session']
const MAX_SESSIONS = 2000
const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60

function nowSeconds(clock = () => Date.now()) {
  return Math.floor(clock() / 1000)
}

function parseCookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const raw = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

export function oidcSessionToken(cookieHeader) {
  for (const name of SESSION_COOKIE_NAMES) {
    const token = parseCookieValue(cookieHeader, name)
    if (token) return token
  }
  return null
}

export function oidcSessionFingerprint(cookieHeader) {
  const token = oidcSessionToken(cookieHeader)
  if (!token) return null
  return createHash('sha256').update(token).digest('hex')
}

function inspectTrustedSessionToken(token) {
  const [body] = String(token || '').split('.', 2)
  if (!body) throw new Error('OIDC session cookie is malformed')
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new Error('OIDC session cookie payload is malformed')
  }
  if (payload.kind !== 'oidc-session') throw new Error('OIDC session cookie type is invalid')
  const issuedAt = Number(payload.iat)
  const expiresAt = Number(payload.exp)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('OIDC session cookie lifetime is invalid')
  }
  if (expiresAt - issuedAt > MAX_SESSION_TTL_SECONDS + 300) {
    throw new Error('OIDC session cookie lifetime exceeds the supported maximum')
  }
  return { payload, issuedAt, expiresAt }
}

function normalizeRegistry(value = {}) {
  return {
    version: 1,
    generation: Math.max(1, Number(value.generation || 1)),
    sessions: value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
      ? structuredClone(value.sessions)
      : {},
  }
}

function pruneRegistry(registry, now) {
  for (const [fingerprint, session] of Object.entries(registry.sessions)) {
    const expiresAt = Number(session?.expiresAt || 0)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) delete registry.sessions[fingerprint]
  }

  const entries = Object.entries(registry.sessions)
  if (entries.length <= MAX_SESSIONS) return
  entries
    .sort((left, right) => Number(left[1]?.issuedAt || 0) - Number(right[1]?.issuedAt || 0))
    .slice(0, entries.length - MAX_SESSIONS)
    .forEach(([fingerprint]) => delete registry.sessions[fingerprint])
}

export async function registerOidcSession(store, { cookieHeader, principal, clock = () => Date.now() }) {
  const token = oidcSessionToken(cookieHeader)
  const fingerprint = oidcSessionFingerprint(cookieHeader)
  if (!token || !fingerprint) throw new Error('OIDC session cookie is required for server-side registration')
  const { payload, issuedAt, expiresAt } = inspectTrustedSessionToken(token)
  if (!principal?.id || payload.id !== principal.id) throw new Error('OIDC session principal does not match the signed session')
  const now = nowSeconds(clock)
  if (expiresAt <= now) throw new Error('OIDC session is already expired')

  const session = {
    fingerprint,
    principalId: principal.id,
    subject: principal.subject ?? payload.subject ?? null,
    issuer: principal.issuer ?? payload.issuer ?? null,
    role: principal.role,
    issuedAt,
    expiresAt,
    revokedAt: null,
    revokedBy: null,
  }
  if (typeof store.oidcSessionRegister === 'function') {
    return store.oidcSessionRegister(session, { now })
  }

  return mutateSystemSection(store, 'core', (core) => {
    const registry = normalizeRegistry(core.oidcSessions)
    pruneRegistry(registry, now)
    registry.sessions[fingerprint] = {
      principalId: session.principalId,
      subject: session.subject,
      issuer: session.issuer,
      role: session.role,
      issuedAt,
      expiresAt,
      revokedAt: null,
    }
    pruneRegistry(registry, now)
    core.oidcSessions = registry
    return { fingerprint, expiresAt, generation: registry.generation }
  })
}

export async function oidcSessionIsActive(store, { cookieHeader, principal, clock = () => Date.now() }) {
  const fingerprint = oidcSessionFingerprint(cookieHeader)
  if (!fingerprint || !principal?.id) return false
  const now = nowSeconds(clock)
  if (typeof store.oidcSessionActive === 'function') {
    return store.oidcSessionActive({ fingerprint, principalId: principal.id, now })
  }

  const core = await readSystemSection(store, 'core')
  const registry = normalizeRegistry(core.oidcSessions)
  const session = registry.sessions[fingerprint]
  if (!session) return false
  return session.principalId === principal.id
    && !session.revokedAt
    && Number(session.expiresAt || 0) > now
}

export async function revokeOidcSession(store, { cookieHeader, actor = null, clock = () => Date.now() }) {
  const fingerprint = oidcSessionFingerprint(cookieHeader)
  if (!fingerprint) return { revoked: false, reason: 'session-cookie-missing' }
  const now = nowSeconds(clock)
  if (typeof store.oidcSessionRevoke === 'function') {
    return store.oidcSessionRevoke({ fingerprint, actor, now })
  }

  return mutateSystemSection(store, 'core', (core) => {
    const registry = normalizeRegistry(core.oidcSessions)
    pruneRegistry(registry, now)
    const session = registry.sessions[fingerprint]
    if (!session) {
      core.oidcSessions = registry
      return { revoked: false, reason: 'session-not-registered' }
    }
    session.revokedAt = now
    session.revokedBy = actor
    core.oidcSessions = registry
    return { revoked: true, fingerprint, revokedAt: now }
  })
}

export async function revokeAllOidcSessions(store, { actor = null, clock = () => Date.now() } = {}) {
  const now = nowSeconds(clock)
  if (typeof store.oidcSessionsRevokeAll === 'function') {
    return store.oidcSessionsRevokeAll({ actor, now })
  }

  return mutateSystemSection(store, 'core', (core) => {
    const previous = normalizeRegistry(core.oidcSessions)
    const revokedCount = Object.values(previous.sessions).filter((session) => Number(session?.expiresAt || 0) > now && !session?.revokedAt).length
    core.oidcSessions = {
      version: 1,
      generation: previous.generation + 1,
      sessions: {},
      revokedAllAt: now,
      revokedAllBy: actor,
    }
    return { revokedCount, generation: previous.generation + 1, revokedAt: now }
  })
}

export async function oidcSessionRegistrySummary(store, { clock = () => Date.now() } = {}) {
  const now = nowSeconds(clock)
  if (typeof store.oidcSessionSummary === 'function') {
    return store.oidcSessionSummary({ now })
  }

  const core = await readSystemSection(store, 'core')
  const registry = normalizeRegistry(core.oidcSessions)
  const sessions = Object.values(registry.sessions)
  return {
    generation: registry.generation,
    active: sessions.filter((session) => !session?.revokedAt && Number(session?.expiresAt || 0) > now).length,
    revoked: sessions.filter((session) => Boolean(session?.revokedAt) && Number(session?.expiresAt || 0) > now).length,
  }
}
