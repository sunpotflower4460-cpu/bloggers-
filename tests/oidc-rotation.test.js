import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createOidcManager, loadOidcConfig } from '../src/oidc.js'

const OLD_SECRET = 'old-session-secret-0123456789abcdef0123456789abcdef'
const NEW_SECRET = 'new-session-secret-0123456789abcdef0123456789abcdef'

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function cookiePair(setCookie) {
  return String(setCookie).split(';', 1)[0]
}

function envFor(secret, extra = {}) {
  return {
    BLOGGERS_OIDC_ISSUER: 'https://issuer.example.com',
    BLOGGERS_OIDC_CLIENT_ID: 'bloggers-client',
    BLOGGERS_PUBLIC_BASE_URL: 'https://bloggers.example.com',
    BLOGGERS_SESSION_SECRET_REF: 'CURRENT_SESSION_SECRET',
    CURRENT_SESSION_SECRET: secret,
    BLOGGERS_OIDC_ROLE_RULES_JSON: JSON.stringify([
      { claim: 'groups', value: 'bloggers-admins', role: 'admin' },
    ]),
    ...extra,
  }
}

function issuerFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  Object.assign(jwk, { kid: 'kid-rotation', use: 'sig', alg: 'RS256' })
  let expectedNonce = null

  function idToken() {
    const now = 1_800_000_000
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'kid-rotation', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://issuer.example.com',
      sub: 'rotating-user',
      aud: 'bloggers-client',
      exp: now + 600,
      iat: now - 10,
      nonce: expectedNonce,
      name: 'Rotating User',
      groups: ['bloggers-admins'],
    })).toString('base64url')
    const input = `${header}.${payload}`
    const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')
    return `${input}.${signature}`
  }

  return {
    setNonce(value) { expectedNonce = value },
    fetchFn: async (url) => {
      const href = String(url)
      if (href.endsWith('/.well-known/openid-configuration')) {
        return jsonResponse({
          issuer: 'https://issuer.example.com',
          authorization_endpoint: 'https://issuer.example.com/authorize',
          token_endpoint: 'https://issuer.example.com/token',
          jwks_uri: 'https://issuer.example.com/jwks',
        })
      }
      if (href.endsWith('/jwks')) return jsonResponse({ keys: [jwk] })
      if (href.endsWith('/token')) return jsonResponse({ id_token: idToken(), access_token: 'access', token_type: 'Bearer' })
      throw new Error(`Unexpected OIDC fetch: ${href}`)
    },
  }
}

async function login(manager, fixture) {
  const started = await manager.beginLogin()
  const authorization = new URL(started.redirectUrl)
  fixture.setNonce(authorization.searchParams.get('nonce'))
  const completed = await manager.completeLogin({
    query: { code: 'code', state: authorization.searchParams.get('state') },
    cookieHeader: cookiePair(started.setCookies[0]),
  })
  return { started, completed }
}

test('old signed OIDC session is accepted only while its previous signing key is configured', async () => {
  const nowMs = 1_800_000_000_000
  const fixture = issuerFixture()
  const oldManager = createOidcManager({ env: envFor(OLD_SECRET), fetchFn: fixture.fetchFn, clock: () => nowMs })
  const oldLogin = await login(oldManager, fixture)
  const oldSession = cookiePair(oldLogin.completed.setCookies[0])

  const withoutGrace = createOidcManager({ env: envFor(NEW_SECRET), fetchFn: fixture.fetchFn, clock: () => nowMs })
  assert.equal(withoutGrace.status(oldSession).authenticated, false)

  const withGrace = createOidcManager({
    env: envFor(NEW_SECRET, {
      BLOGGERS_SESSION_PREVIOUS_SECRET_REFS: 'OLD_SESSION_SECRET',
      OLD_SESSION_SECRET: OLD_SECRET,
    }),
    fetchFn: fixture.fetchFn,
    clock: () => nowMs,
  })
  assert.equal(withGrace.status(oldSession).authenticated, true)
  assert.equal(withGrace.status(oldSession).principal.id, 'oidc:rotating-user')
  assert.equal(withGrace.config.previousSessionSecretCount, 1)
})

test('in-flight OIDC flow signed by the previous key completes after rotation and new session is current-key only', async () => {
  const nowMs = 1_800_000_000_000
  const fixture = issuerFixture()
  const oldManager = createOidcManager({ env: envFor(OLD_SECRET), fetchFn: fixture.fetchFn, clock: () => nowMs })
  const started = await oldManager.beginLogin({ returnTo: '/settings' })
  const authorization = new URL(started.redirectUrl)
  fixture.setNonce(authorization.searchParams.get('nonce'))

  const rotatedManager = createOidcManager({
    env: envFor(NEW_SECRET, {
      BLOGGERS_SESSION_PREVIOUS_SECRET_REFS: 'OLD_SESSION_SECRET',
      OLD_SESSION_SECRET: OLD_SECRET,
    }),
    fetchFn: fixture.fetchFn,
    clock: () => nowMs,
  })
  const completed = await rotatedManager.completeLogin({
    query: { code: 'code-after-rotation', state: authorization.searchParams.get('state') },
    cookieHeader: cookiePair(started.setCookies[0]),
  })
  const newSession = cookiePair(completed.setCookies[0])

  assert.equal(completed.returnTo, '/settings')
  assert.equal(rotatedManager.status(newSession).authenticated, true)
  assert.equal(oldManager.status(newSession).authenticated, false)

  const currentOnly = createOidcManager({ env: envFor(NEW_SECRET), fetchFn: fixture.fetchFn, clock: () => nowMs })
  assert.equal(currentOnly.status(newSession).authenticated, true)
})

test('previous signing key configuration is bounded, deduplicated, and fail-closed for weak keys', () => {
  const config = loadOidcConfig(envFor(NEW_SECRET, {
    BLOGGERS_SESSION_PREVIOUS_SECRET_REFS: 'OLD_A,OLD_B,OLD_C',
    OLD_A: OLD_SECRET,
    OLD_B: OLD_SECRET,
    OLD_C: 'third-session-secret-0123456789abcdef0123456789abcdef',
  }))
  assert.equal(config.previousSessionSecretCount, 1)

  assert.throws(
    () => loadOidcConfig(envFor(NEW_SECRET, {
      BLOGGERS_SESSION_PREVIOUS_SECRET_REFS: 'WEAK_OLD_SECRET',
      WEAK_OLD_SECRET: 'too-short',
    })),
    /at least 32 bytes/,
  )
})
