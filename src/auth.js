// @feature F-001
// @feature F-009
// @feature F-012
import { timingSafeEqual } from 'node:crypto'

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 }

function clean(value) {
  return String(value ?? '').trim()
}

function tokenMatches(expected, actual) {
  if (!expected || !actual) return false
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  if (expectedBuffer.length !== actualBuffer.length) return false
  return timingSafeEqual(expectedBuffer, actualBuffer)
}

function parseRbacEntries(env) {
  const raw = clean(env.BLOGGERS_RBAC_JSON)
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('BLOGGERS_RBAC_JSON must be valid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('BLOGGERS_RBAC_JSON must be an array')

  return parsed.map((entry, index) => {
    const role = clean(entry?.role).toLowerCase()
    const tokenEnv = clean(entry?.tokenEnv)
    if (!ROLE_RANK[role]) throw new Error(`Invalid RBAC role at index ${index}`)
    if (!tokenEnv) throw new Error(`RBAC tokenEnv is required at index ${index}`)
    return {
      id: clean(entry?.id) || `principal-${index + 1}`,
      name: clean(entry?.name) || clean(entry?.id) || `principal-${index + 1}`,
      role,
      tokenEnv,
      token: clean(env[tokenEnv]),
    }
  }).filter((entry) => entry.token)
}

export function loadAuthConfig(env = process.env) {
  const principals = parseRbacEntries(env)
  const legacyAdmin = clean(env.BLOGGERS_ADMIN_TOKEN)
  if (legacyAdmin) {
    principals.push({
      id: 'legacy-admin',
      name: 'Legacy Admin Token',
      role: 'admin',
      tokenEnv: 'BLOGGERS_ADMIN_TOKEN',
      token: legacyAdmin,
    })
  }
  return {
    principals,
    configured: principals.length > 0,
    roles: Object.keys(ROLE_RANK),
  }
}

export function requiredRole(method, pathname) {
  const verb = String(method || 'GET').toUpperCase()

  if (pathname.startsWith('/api/settings')) return 'admin'
  if (pathname === '/api/jobs') return 'editor'
  if (pathname === '/api/system/pause') return 'editor'
  if (pathname === '/api/system/resume') return 'admin'

  if (verb === 'GET' || verb === 'HEAD') return 'viewer'

  if (pathname === '/api/workflows/run') return 'editor'
  if (/^\/api\/approvals\/[^/]+\/resolve$/.test(pathname)) return 'editor'
  if (pathname === '/api/blogs' && verb === 'POST') return 'editor'
  if (/^\/api\/blogs\/[^/]+(?:\/test-connection)?$/.test(pathname)) return 'editor'

  return 'admin'
}

export function authenticateToken(token, config) {
  const actual = clean(token)
  if (!actual) return null
  for (const principal of config.principals) {
    if (tokenMatches(principal.token, actual)) {
      return { id: principal.id, name: principal.name, role: principal.role, tokenEnv: principal.tokenEnv }
    }
  }
  return null
}

export function authorizeApiAccess({ method, pathname, token, loopback, config }) {
  if (!config.configured) {
    if (loopback) return { ok: true, role: 'admin', principal: { id: 'local', name: 'Localhost', role: 'admin' } }
    return {
      ok: false,
      status: 403,
      error: 'Remote API access is disabled until BLOGGERS_ADMIN_TOKEN or BLOGGERS_RBAC_JSON is configured.',
    }
  }

  const principal = authenticateToken(token, config)
  if (!principal) return { ok: false, status: 401, error: 'A valid Bloggers access token is required.' }

  const required = requiredRole(method, pathname)
  if (ROLE_RANK[principal.role] < ROLE_RANK[required]) {
    return {
      ok: false,
      status: 403,
      error: `This action requires the ${required} role.`,
      principal,
      requiredRole: required,
    }
  }

  return { ok: true, role: principal.role, principal, requiredRole: required }
}

export function publicAuthSummary(config) {
  const counts = { viewer: 0, editor: 0, admin: 0 }
  for (const principal of config.principals) counts[principal.role] += 1
  return {
    configured: config.configured,
    roles: counts,
    remoteAccessRequiresToken: true,
  }
}
