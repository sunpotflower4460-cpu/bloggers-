import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createOidcManager, loadOidcConfig } from '../src/oidc.js'

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function cookiePair(setCookie) {
  return String(setCookie).split(';', 1)[0]
}

function createIssuerFixture({ nonceOverride = null, groups = ['bloggers-admins'] } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  Object.assign(jwk, { kid: 'kid-1', use: 'sig', alg: 'RS256' })
  let expectedNonce = null
  const calls = []

  function idToken() {
    const now = 1_800_000_000
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://issuer.example.com',
      sub: 'user-123',
      aud: 'bloggers-client',
      exp: now + 600,
      iat: now - 10,
      nonce: nonceOverride ?? expectedNonce,
      name: 'Editorial Admin',
      groups,
    })).toString('base64url')
    const input = `${header}.${payload}`
    const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')
    return `${input}.${signature}`
  }

  const fetchFn = async (url, options = {}) => {
    const href = String(url)
    calls.push({ href, method: options.method || 'GET', body: options.body, headers: options.headers })
    if (href.endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: 'https://issuer.example.com',
        authorization_endpoint: 'https://issuer.example.com/authorize',
        token_endpoint: 'https://issuer.example.com/token',
        jwks_uri: 'https://issuer.example.com/jwks',
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    }
    if (href.endsWith('/jwks')) return jsonResponse({ keys: [jwk] })
    if (href.endsWith('/token')) return jsonResponse({ access_token: 'access', token_type: 'Bearer', id_token: idToken() })
    throw new Error(`Unexpected OIDC fetch: ${href}`)
  }

  return {
    fetchFn,
    calls,
    setExpectedNonce(value) { expectedNonce = value },
  }
}

function oidcEnv(extra = {}) {
  return {
    BLOGGERS_OIDC_ISSUER: 'https://issuer.example.com',
    BLOGGERS_OIDC_CLIENT_ID: 'bloggers-client',
    BLOGGERS_OIDC_CLIENT_SECRET_REF: 'OIDC_CLIENT_SECRET',
    OIDC_CLIENT_SECRET: 'provider-secret',
    BLOGGERS_PUBLIC_BASE_URL: 'https://bloggers.example.com',
    BLOGGERS_SESSION_SECRET_REF: 'SESSION_SECRET',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    BLOGGERS_OIDC_ROLE_RULES_JSON: JSON.stringify([
      { claim: 'groups', value: 'bloggers-admins', role: 'admin' },
      { claim: 'groups', value: 'bloggers-editors', role: 'editor' },
    ]),
    ...extra,
  }
}

test('OIDC login uses PKCE/state/nonce, verifies JWKS signature, and creates a signed HttpOnly session', async () => {
  const fixture = createIssuerFixture()
  const nowMs = 1_800_000_000_000
  const manager = createOidcManager({ env: oidcEnv(), fetchFn: fixture.fetchFn, clock: () => nowMs })

  const login = await manager.beginLogin({ returnTo: '/settings?tab=auth' })
  const authorization = new URL(login.redirectUrl)
  assert.equal(authorization.origin, 'https://issuer.example.com')
  assert.equal(authorization.searchParams.get('response_type'), 'code')
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(authorization.searchParams.get('code_challenge')?.length > 30)
  assert.ok(authorization.searchParams.get('state')?.length > 20)
  assert.ok(authorization.searchParams.get('nonce')?.length > 20)
  assert.match(login.setCookies[0], /^__Host-bloggers_oidc_flow=/)
  assert.match(login.setCookies[0], /HttpOnly/)
  assert.match(login.setCookies[0], /SameSite=Lax/)
  assert.match(login.setCookies[0], /Secure/)
  fixture.setExpectedNonce(authorization.searchParams.get('nonce'))

  const completed = await manager.completeLogin({
    query: { code: 'authorization-code', state: authorization.searchParams.get('state') },
    cookieHeader: cookiePair(login.setCookies[0]),
  })

  assert.equal(completed.principal.role, 'admin')
  assert.equal(completed.principal.authType, 'oidc')
  assert.equal(completed.returnTo, '/settings?tab=auth')
  assert.match(completed.setCookies[0], /^__Host-bloggers_session=/)
  assert.match(completed.setCookies[0], /HttpOnly/)
  assert.match(completed.setCookies[0], /SameSite=Strict/)
  assert.match(completed.setCookies[0], /Secure/)

  const tokenCall = fixture.calls.find((call) => call.href.endsWith('/token'))
  const tokenBody = new URLSearchParams(tokenCall.body)
  assert.equal(tokenBody.get('grant_type'), 'authorization_code')
  assert.equal(tokenBody.get('code'), 'authorization-code')
  assert.ok(tokenBody.get('code_verifier')?.length > 30)
  assert.match(String(tokenCall.headers.Authorization), /^Basic /)
  assert.equal(tokenBody.has('client_secret'), false)

  const sessionCookie = cookiePair(completed.setCookies[0])
  const status = manager.status(sessionCookie)
  assert.equal(status.authenticated, true)
  assert.equal(status.principal.role, 'admin')
  assert.equal(status.principal.name, 'Editorial Admin')
  assert.equal(manager.trustedMutationOrigin('https://bloggers.example.com'), true)
  assert.equal(manager.trustedMutationOrigin('https://evil.example.com'), false)
})

test('localhost HTTP OIDC uses non-__Host cookie names and never emits a misleading Secure prefix contract', async () => {
  const fixture = createIssuerFixture()
  const nowMs = 1_800_000_000_000
  const manager = createOidcManager({
    env: oidcEnv({
      BLOGGERS_PUBLIC_BASE_URL: 'http://localhost:3000',
      BLOGGERS_OIDC_ALLOW_INSECURE_LOCALHOST: 'true',
    }),
    fetchFn: fixture.fetchFn,
    clock: () => nowMs,
  })

  const login = await manager.beginLogin()
  const authorization = new URL(login.redirectUrl)
  fixture.setExpectedNonce(authorization.searchParams.get('nonce'))
  assert.match(login.setCookies[0], /^bloggers_oidc_flow=/)
  assert.doesNotMatch(login.setCookies[0], /^__Host-/)
  assert.doesNotMatch(login.setCookies[0], /(?:^|; )Secure(?:;|$)/)

  const completed = await manager.completeLogin({
    query: { code: 'code', state: authorization.searchParams.get('state') },
    cookieHeader: cookiePair(login.setCookies[0]),
  })
  assert.match(completed.setCookies[0], /^bloggers_session=/)
  assert.doesNotMatch(completed.setCookies[0], /^__Host-/)
  assert.doesNotMatch(completed.setCookies[0], /(?:^|; )Secure(?:;|$)/)
  assert.equal(manager.status(cookiePair(completed.setCookies[0])).authenticated, true)
})

test('OIDC callback rejects state and nonce mismatches', async () => {
  const nowMs = 1_800_000_000_000
  const fixture = createIssuerFixture({ nonceOverride: 'wrong-nonce' })
  const manager = createOidcManager({ env: oidcEnv(), fetchFn: fixture.fetchFn, clock: () => nowMs })
  const login = await manager.beginLogin()
  const authorization = new URL(login.redirectUrl)
  fixture.setExpectedNonce(authorization.searchParams.get('nonce'))

  await assert.rejects(
    () => manager.completeLogin({
      query: { code: 'code', state: 'wrong-state' },
      cookieHeader: cookiePair(login.setCookies[0]),
    }),
    (error) => error?.code === 'OIDC_STATE_MISMATCH',
  )

  await assert.rejects(
    () => manager.completeLogin({
      query: { code: 'code', state: authorization.searchParams.get('state') },
      cookieHeader: cookiePair(login.setCookies[0]),
    }),
    (error) => error?.code === 'OIDC_NONCE_MISMATCH',
  )
})

test('OIDC denies identities that have no configured role mapping', async () => {
  const fixture = createIssuerFixture({ groups: ['unrelated-group'] })
  const nowMs = 1_800_000_000_000
  const manager = createOidcManager({ env: oidcEnv(), fetchFn: fixture.fetchFn, clock: () => nowMs })
  const login = await manager.beginLogin()
  const authorization = new URL(login.redirectUrl)
  fixture.setExpectedNonce(authorization.searchParams.get('nonce'))

  await assert.rejects(
    () => manager.completeLogin({
      query: { code: 'code', state: authorization.searchParams.get('state') },
      cookieHeader: cookiePair(login.setCookies[0]),
    }),
    (error) => error?.code === 'OIDC_USER_NOT_ALLOWED' && error?.status === 403,
  )
})

test('tampered signed sessions are ignored rather than trusted', async () => {
  const fixture = createIssuerFixture()
  const nowMs = 1_800_000_000_000
  const manager = createOidcManager({ env: oidcEnv(), fetchFn: fixture.fetchFn, clock: () => nowMs })
  const login = await manager.beginLogin()
  const authorization = new URL(login.redirectUrl)
  fixture.setExpectedNonce(authorization.searchParams.get('nonce'))
  const completed = await manager.completeLogin({
    query: { code: 'code', state: authorization.searchParams.get('state') },
    cookieHeader: cookiePair(login.setCookies[0]),
  })
  const pair = cookiePair(completed.setCookies[0])
  const [name, value] = pair.split('=', 2)
  const tampered = `${name}=${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`
  assert.equal(manager.status(tampered).authenticated, false)
})

test('OIDC configuration is fail-closed and requires a long session signing secret', () => {
  assert.deepEqual(loadOidcConfig({}), { enabled: false })
  assert.throws(
    () => loadOidcConfig(oidcEnv({ SESSION_SECRET: 'too-short' })),
    /at least 32 bytes/,
  )
  assert.throws(
    () => loadOidcConfig(oidcEnv({ BLOGGERS_PUBLIC_BASE_URL: 'http://bloggers.example.com' })),
    /must use HTTPS/,
  )
})
