// @feature F-001
// @feature F-009
// @feature F-012
import {
  constants,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import { resolveSecret } from './secrets.js'

const ROLES = new Set(['viewer', 'editor', 'admin'])
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60
const FLOW_TTL_SECONDS = 10 * 60
const DEFAULT_TIMEOUT_MS = 12_000
const SECURE_SESSION_COOKIE = '__Host-bloggers_session'
const SECURE_FLOW_COOKIE = '__Host-bloggers_oidc_flow'
const LOCAL_SESSION_COOKIE = 'bloggers_session'
const LOCAL_FLOW_COOKIE = 'bloggers_oidc_flow'
const MAX_PREVIOUS_SESSION_SECRETS = 2

function clean(value) {
  return String(value ?? '').trim()
}

function bool(value) {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase())
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function fail(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function parseBase64UrlJson(value, label) {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
  } catch {
    throw fail('OIDC_INVALID_TOKEN', `${label} is not valid base64url JSON`, 401)
  }
}

function signEnvelope(payload, secret) {
  const body = base64UrlJson(payload)
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

function verifyEnvelope(value, secrets, { kind, now }) {
  const parts = clean(value).split('.')
  if (parts.length !== 2) throw fail('OIDC_INVALID_COOKIE', 'Authentication cookie is malformed', 401)
  const candidates = Array.isArray(secrets) ? secrets : [secrets]
  let signatureValid = false
  for (const secret of candidates) {
    const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url')
    signatureValid = safeEqual(expected, parts[1]) || signatureValid
  }
  if (!signatureValid) throw fail('OIDC_INVALID_COOKIE', 'Authentication cookie signature is invalid', 401)
  const payload = parseBase64UrlJson(parts[0], 'Authentication cookie')
  if (payload.kind !== kind) throw fail('OIDC_INVALID_COOKIE', 'Authentication cookie type is invalid', 401)
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Math.floor(now / 1000)) {
    throw fail('OIDC_COOKIE_EXPIRED', 'Authentication cookie has expired', 401)
  }
  return payload
}

function parseCookies(header) {
  const result = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const raw = part.slice(index + 1).trim()
    try {
      result[name] = decodeURIComponent(raw)
    } catch {
      result[name] = raw
    }
  }
  return result
}

function serializeCookie(name, value, { maxAge, sameSite, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${Math.max(0, Math.round(maxAge))}`,
  ]
  if (secure) parts.push('Secure')
  if (maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
  return parts.join('; ')
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function checkedUrl(raw, label, { allowInsecureLocalhost = false } = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (url.username || url.password) throw new Error(`${label} must not include URL credentials`)
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && allowInsecureLocalhost && isLoopbackHostname(url.hostname)) return url
  throw new Error(`${label} must use HTTPS${allowInsecureLocalhost ? ' (HTTP is allowed only for localhost)' : ''}`)
}

function safeReturnTo(value) {
  const path = clean(value) || '/'
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/'
  return path
}

function parseRoleRules(raw) {
  if (!clean(raw)) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('BLOGGERS_OIDC_ROLE_RULES_JSON must be valid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('BLOGGERS_OIDC_ROLE_RULES_JSON must be an array')
  return parsed.map((rule, index) => {
    const claim = clean(rule?.claim)
    const value = clean(rule?.value)
    const role = clean(rule?.role).toLowerCase()
    if (!claim || !value || !ROLES.has(role)) throw new Error(`Invalid OIDC role rule at index ${index}`)
    return { claim, value, role }
  })
}

function parsePreviousSecretRefs(raw) {
  return clean(raw)
    .split(',')
    .map((value) => clean(value))
    .filter(Boolean)
    .slice(0, MAX_PREVIOUS_SESSION_SECRETS)
}

function valuesOfClaim(value) {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (value === null || value === undefined) return []
  return [String(value)]
}

function principalFromClaims(claims, config) {
  const subject = clean(claims.sub)
  if (!subject) throw fail('OIDC_INVALID_TOKEN', 'OIDC ID token is missing sub', 401)

  let role = null
  for (const rule of config.roleRules) {
    if (valuesOfClaim(claims[rule.claim]).some((value) => safeEqual(value, rule.value))) {
      role = rule.role
      break
    }
  }
  role ??= config.defaultRole
  if (!role) throw fail('OIDC_USER_NOT_ALLOWED', 'This OIDC identity is not mapped to a Bloggers role', 403)

  const display = clean(claims.name) || clean(claims.preferred_username) || clean(claims.email) || subject
  return {
    id: `oidc:${subject}`,
    name: display,
    role,
    authType: 'oidc',
    subject,
    issuer: config.issuer,
  }
}

function jwtParts(token) {
  const parts = clean(token).split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) throw fail('OIDC_INVALID_TOKEN', 'OIDC ID token is malformed', 401)
  return {
    encodedHeader: parts[0],
    encodedPayload: parts[1],
    encodedSignature: parts[2],
    header: parseBase64UrlJson(parts[0], 'OIDC JWT header'),
    claims: parseBase64UrlJson(parts[1], 'OIDC JWT payload'),
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature: Buffer.from(parts[2], 'base64url'),
  }
}

function verifyWithJwk(jwt, jwk) {
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  if (jwt.header.alg === 'RS256') return verifySignature('RSA-SHA256', jwt.signingInput, key, jwt.signature)
  if (jwt.header.alg === 'PS256') {
    return verifySignature('sha256', jwt.signingInput, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, jwt.signature)
  }
  if (jwt.header.alg === 'ES256') {
    return verifySignature('sha256', jwt.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jwt.signature)
  }
  throw fail('OIDC_UNSUPPORTED_ALG', `Unsupported OIDC signing algorithm: ${jwt.header.alg}`, 401)
}

function audienceMatches(aud, clientId) {
  if (Array.isArray(aud)) return aud.some((value) => safeEqual(value, clientId))
  return safeEqual(aud, clientId)
}

export function loadOidcConfig(env = process.env) {
  const issuerRaw = clean(env.BLOGGERS_OIDC_ISSUER)
  const clientId = clean(env.BLOGGERS_OIDC_CLIENT_ID)
  const publicBaseRaw = clean(env.BLOGGERS_PUBLIC_BASE_URL)
  const sessionSecretRef = clean(env.BLOGGERS_SESSION_SECRET_REF)
  const clientSecretRef = clean(env.BLOGGERS_OIDC_CLIENT_SECRET_REF)
  const previousSessionSecretRefs = parsePreviousSecretRefs(env.BLOGGERS_SESSION_PREVIOUS_SECRET_REFS)
  const requested = Boolean(issuerRaw || clientId || publicBaseRaw || sessionSecretRef || clientSecretRef || previousSessionSecretRefs.length)

  if (!requested) return { enabled: false }
  if (!issuerRaw || !clientId || !publicBaseRaw || !sessionSecretRef) {
    throw new Error('OIDC requires BLOGGERS_OIDC_ISSUER, BLOGGERS_OIDC_CLIENT_ID, BLOGGERS_PUBLIC_BASE_URL, and BLOGGERS_SESSION_SECRET_REF')
  }

  const allowInsecureLocalhost = bool(env.BLOGGERS_OIDC_ALLOW_INSECURE_LOCALHOST)
  const issuer = checkedUrl(issuerRaw, 'BLOGGERS_OIDC_ISSUER', { allowInsecureLocalhost }).toString().replace(/\/$/, '')
  const publicBaseUrl = checkedUrl(publicBaseRaw, 'BLOGGERS_PUBLIC_BASE_URL', { allowInsecureLocalhost }).toString().replace(/\/$/, '')
  const sessionSecret = resolveSecret(sessionSecretRef, { env, required: true, label: 'OIDC session signing secret' })
  if (Buffer.byteLength(sessionSecret) < 32) throw new Error('OIDC session signing secret must be at least 32 bytes')

  const previousSessionSecrets = []
  for (const reference of previousSessionSecretRefs) {
    const secret = resolveSecret(reference, { env, required: true, label: `Previous OIDC session signing secret ${reference}` })
    if (Buffer.byteLength(secret) < 32) throw new Error(`Previous OIDC session signing secret ${reference} must be at least 32 bytes`)
    if (safeEqual(secret, sessionSecret)) continue
    if (previousSessionSecrets.some((item) => safeEqual(item, secret))) continue
    previousSessionSecrets.push(secret)
  }
  const sessionSecrets = [sessionSecret, ...previousSessionSecrets]

  const clientSecret = clientSecretRef
    ? resolveSecret(clientSecretRef, { env, required: true, label: 'OIDC client secret' })
    : null

  const defaultRole = clean(env.BLOGGERS_OIDC_DEFAULT_ROLE).toLowerCase() || null
  if (defaultRole && !ROLES.has(defaultRole)) throw new Error('BLOGGERS_OIDC_DEFAULT_ROLE must be viewer, editor, or admin')

  return {
    enabled: true,
    issuer,
    clientId,
    clientSecret,
    publicBaseUrl,
    redirectUri: `${publicBaseUrl}/auth/callback`,
    scopes: clean(env.BLOGGERS_OIDC_SCOPES) || 'openid profile email',
    roleRules: parseRoleRules(env.BLOGGERS_OIDC_ROLE_RULES_JSON),
    defaultRole,
    sessionSecret,
    sessionSecrets,
    previousSessionSecretCount: previousSessionSecrets.length,
    sessionTtlSeconds: clampInteger(env.BLOGGERS_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, 900, 24 * 60 * 60),
    clockSkewSeconds: clampInteger(env.BLOGGERS_OIDC_CLOCK_SKEW_SECONDS, 60, 0, 300),
    timeoutMs: clampInteger(env.BLOGGERS_OIDC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60_000),
    secureCookies: new URL(publicBaseUrl).protocol === 'https:',
    allowInsecureLocalhost,
  }
}

export function createOidcManager({ env = process.env, fetchFn = globalThis.fetch, clock = () => Date.now() } = {}) {
  const config = loadOidcConfig(env)
  let discoveryCache = null
  let discoveryCachedAt = 0
  let jwksCache = null
  let jwksCachedAt = 0
  const sessionCookieName = config.enabled && config.secureCookies ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE
  const flowCookieName = config.enabled && config.secureCookies ? SECURE_FLOW_COOKIE : LOCAL_FLOW_COOKIE

  function cookie(name, value, options) {
    return serializeCookie(name, value, { secure: Boolean(config.secureCookies), ...options })
  }

  function clearCookie(name, sameSite = 'Strict') {
    if (!config.enabled) return `${name}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0`
    return cookie(name, '', { maxAge: 0, sameSite })
  }

  function trustedMutationOrigin(origin) {
    if (!config.enabled) return false
    const presented = clean(origin)
    if (!presented) return false
    try {
      return safeEqual(new URL(presented).origin, new URL(config.publicBaseUrl).origin)
    } catch {
      return false
    }
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchFn(url, {
      ...options,
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(config.timeoutMs),
      headers: { Accept: 'application/json', ...(options.headers ?? {}) },
    })
    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      throw fail('OIDC_BAD_RESPONSE', `OIDC endpoint returned invalid JSON (${response.status})`, 502)
    }
    if (!response.ok) throw fail('OIDC_HTTP_ERROR', payload?.error_description || payload?.error || `OIDC HTTP ${response.status}`, 502)
    return payload
  }

  async function discovery({ force = false } = {}) {
    if (!config.enabled) throw fail('OIDC_DISABLED', 'OIDC is not configured', 404)
    const now = clock()
    if (!force && discoveryCache && now - discoveryCachedAt < 60 * 60 * 1000) return discoveryCache
    const url = `${config.issuer}/.well-known/openid-configuration`
    const metadata = await fetchJson(url)
    if (!safeEqual(metadata?.issuer, config.issuer)) throw fail('OIDC_DISCOVERY_MISMATCH', 'OIDC discovery issuer does not match configured issuer', 502)
    for (const [field, label] of [
      ['authorization_endpoint', 'OIDC authorization endpoint'],
      ['token_endpoint', 'OIDC token endpoint'],
      ['jwks_uri', 'OIDC JWKS endpoint'],
    ]) {
      checkedUrl(metadata?.[field], label, { allowInsecureLocalhost: config.allowInsecureLocalhost })
    }
    discoveryCache = metadata
    discoveryCachedAt = now
    return metadata
  }

  async function jwks(metadata, { force = false } = {}) {
    const now = clock()
    if (!force && jwksCache && now - jwksCachedAt < 10 * 60 * 1000) return jwksCache
    const payload = await fetchJson(metadata.jwks_uri)
    if (!Array.isArray(payload?.keys)) throw fail('OIDC_BAD_JWKS', 'OIDC JWKS response does not contain keys', 502)
    jwksCache = payload.keys
    jwksCachedAt = now
    return jwksCache
  }

  async function findVerificationKey(metadata, header) {
    const supported = new Set(['RS256', 'PS256', 'ES256'])
    if (!supported.has(header.alg)) throw fail('OIDC_UNSUPPORTED_ALG', `Unsupported OIDC signing algorithm: ${header.alg}`, 401)
    const choose = (keys) => keys.find((key) => {
      if (header.kid && key.kid !== header.kid) return false
      if (key.use && key.use !== 'sig') return false
      if (key.alg && key.alg !== header.alg) return false
      return true
    })
    let keys = await jwks(metadata)
    let key = choose(keys)
    if (!key) {
      keys = await jwks(metadata, { force: true })
      key = choose(keys)
    }
    if (!key) throw fail('OIDC_KEY_NOT_FOUND', 'No matching OIDC signing key was found', 401)
    return key
  }

  async function verifyIdToken(idToken, expectedNonce) {
    const metadata = await discovery()
    const jwt = jwtParts(idToken)
    const key = await findVerificationKey(metadata, jwt.header)
    if (!verifyWithJwk(jwt, key)) throw fail('OIDC_INVALID_SIGNATURE', 'OIDC ID token signature is invalid', 401)

    const nowSeconds = Math.floor(clock() / 1000)
    const skew = config.clockSkewSeconds
    if (!safeEqual(jwt.claims.iss, config.issuer)) throw fail('OIDC_INVALID_ISSUER', 'OIDC ID token issuer is invalid', 401)
    if (!audienceMatches(jwt.claims.aud, config.clientId)) throw fail('OIDC_INVALID_AUDIENCE', 'OIDC ID token audience is invalid', 401)
    if (Array.isArray(jwt.claims.aud) && jwt.claims.aud.length > 1 && !safeEqual(jwt.claims.azp, config.clientId)) {
      throw fail('OIDC_INVALID_AZP', 'OIDC ID token authorized party is invalid', 401)
    }
    if (!Number.isFinite(Number(jwt.claims.exp)) || Number(jwt.claims.exp) < nowSeconds - skew) throw fail('OIDC_TOKEN_EXPIRED', 'OIDC ID token has expired', 401)
    if (Number.isFinite(Number(jwt.claims.nbf)) && Number(jwt.claims.nbf) > nowSeconds + skew) throw fail('OIDC_TOKEN_NOT_ACTIVE', 'OIDC ID token is not active yet', 401)
    if (Number.isFinite(Number(jwt.claims.iat)) && Number(jwt.claims.iat) > nowSeconds + skew) throw fail('OIDC_TOKEN_IAT_INVALID', 'OIDC ID token issued-at time is in the future', 401)
    if (!safeEqual(jwt.claims.nonce, expectedNonce)) throw fail('OIDC_NONCE_MISMATCH', 'OIDC nonce validation failed', 401)
    return jwt.claims
  }

  async function beginLogin({ returnTo = '/' } = {}) {
    if (!config.enabled) throw fail('OIDC_DISABLED', 'OIDC is not configured', 404)
    const metadata = await discovery()
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const nowSeconds = Math.floor(clock() / 1000)
    const flow = signEnvelope({
      kind: 'oidc-flow',
      state,
      nonce,
      codeVerifier,
      returnTo: safeReturnTo(returnTo),
      iat: nowSeconds,
      exp: nowSeconds + FLOW_TTL_SECONDS,
    }, config.sessionSecret)

    const authorizationUrl = new URL(metadata.authorization_endpoint)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', config.clientId)
    authorizationUrl.searchParams.set('redirect_uri', config.redirectUri)
    authorizationUrl.searchParams.set('scope', config.scopes)
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('nonce', nonce)
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')

    return {
      redirectUrl: authorizationUrl.toString(),
      setCookies: [cookie(flowCookieName, flow, { maxAge: FLOW_TTL_SECONDS, sameSite: 'Lax' })],
    }
  }

  async function completeLogin({ query, cookieHeader }) {
    if (!config.enabled) throw fail('OIDC_DISABLED', 'OIDC is not configured', 404)
    if (query?.error) throw fail('OIDC_PROVIDER_ERROR', clean(query.error_description) || `OIDC provider returned ${clean(query.error)}`, 401)
    const code = clean(query?.code)
    const state = clean(query?.state)
    if (!code || !state) throw fail('OIDC_CALLBACK_INVALID', 'OIDC callback is missing code or state', 400)

    const cookies = parseCookies(cookieHeader)
    const flow = verifyEnvelope(cookies[flowCookieName], config.sessionSecrets, { kind: 'oidc-flow', now: clock() })
    if (!safeEqual(flow.state, state)) throw fail('OIDC_STATE_MISMATCH', 'OIDC state validation failed', 401)

    const metadata = await discovery()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: flow.codeVerifier,
    })
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (config.clientSecret) {
      const methods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
        ? metadata.token_endpoint_auth_methods_supported
        : []
      if (methods.includes('client_secret_basic')) {
        headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
      } else {
        body.set('client_secret', config.clientSecret)
      }
    }

    const tokenSet = await fetchJson(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    })
    if (!tokenSet?.id_token) throw fail('OIDC_ID_TOKEN_MISSING', 'OIDC token response did not include an ID token', 502)
    const claims = await verifyIdToken(tokenSet.id_token, flow.nonce)
    const principal = principalFromClaims(claims, config)
    const nowSeconds = Math.floor(clock() / 1000)
    const session = signEnvelope({
      kind: 'oidc-session',
      id: principal.id,
      name: principal.name,
      role: principal.role,
      authType: 'oidc',
      subject: principal.subject,
      issuer: principal.issuer,
      iat: nowSeconds,
      exp: nowSeconds + config.sessionTtlSeconds,
    }, config.sessionSecret)

    return {
      principal,
      returnTo: safeReturnTo(flow.returnTo),
      setCookies: [
        cookie(sessionCookieName, session, { maxAge: config.sessionTtlSeconds, sameSite: 'Strict' }),
        clearCookie(flowCookieName, 'Lax'),
      ],
    }
  }

  function sessionPrincipal(cookieHeader) {
    if (!config.enabled) return null
    const cookies = parseCookies(cookieHeader)
    if (!cookies[sessionCookieName]) return null
    try {
      const session = verifyEnvelope(cookies[sessionCookieName], config.sessionSecrets, { kind: 'oidc-session', now: clock() })
      if (!ROLES.has(session.role) || !session.id || !session.name) return null
      return {
        id: session.id,
        name: session.name,
        role: session.role,
        authType: 'oidc',
        subject: session.subject ?? null,
        issuer: session.issuer ?? config.issuer,
      }
    } catch {
      return null
    }
  }

  function status(cookieHeader) {
    const principal = sessionPrincipal(cookieHeader)
    return {
      enabled: Boolean(config.enabled),
      authenticated: Boolean(principal),
      issuer: config.enabled ? config.issuer : null,
      principal: principal ? { id: principal.id, name: principal.name, role: principal.role, authType: principal.authType } : null,
    }
  }

  function logoutCookies() {
    return [clearCookie(sessionCookieName, 'Strict'), clearCookie(flowCookieName, 'Lax')]
  }

  return {
    enabled: Boolean(config.enabled),
    config: config.enabled ? {
      issuer: config.issuer,
      clientId: config.clientId,
      publicBaseUrl: config.publicBaseUrl,
      sessionTtlSeconds: config.sessionTtlSeconds,
      previousSessionSecretCount: config.previousSessionSecretCount,
    } : { enabled: false },
    beginLogin,
    completeLogin,
    sessionPrincipal,
    status,
    logoutCookies,
    trustedMutationOrigin,
    verifyIdToken,
  }
}
