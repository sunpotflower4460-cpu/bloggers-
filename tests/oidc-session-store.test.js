import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonStore } from '../src/store.js'
import {
  oidcSessionFingerprint,
  oidcSessionIsActive,
  oidcSessionRegistrySummary,
  registerOidcSession,
  revokeAllOidcSessions,
  revokeOidcSession,
} from '../src/oidc-session-store.js'

function sessionCookie({ id = 'oidc:user-1', subject = 'user-1', role = 'admin', issuedAt = 1_800_000_000, expiresAt = issuedAt + 3600 } = {}) {
  const payload = Buffer.from(JSON.stringify({
    kind: 'oidc-session',
    id,
    name: 'Editor',
    role,
    authType: 'oidc',
    subject,
    issuer: 'https://issuer.example.com',
    iat: issuedAt,
    exp: expiresAt,
  })).toString('base64url')
  return `__Host-bloggers_session=${payload}.trusted-test-signature`
}

async function withStore(work) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-oidc-session-'))
  try {
    const store = await new JsonStore(join(dir, 'state.json')).init()
    return await work(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const principal = {
  id: 'oidc:user-1',
  name: 'Editor',
  role: 'admin',
  authType: 'oidc',
  subject: 'user-1',
  issuer: 'https://issuer.example.com',
}

test('server-side OIDC registry requires explicit login registration before a signed session is active', async () => {
  await withStore(async (store) => {
    const cookieHeader = sessionCookie()
    const clock = () => 1_800_000_100_000

    assert.equal(await oidcSessionIsActive(store, { cookieHeader, principal, clock }), false)
    const registered = await registerOidcSession(store, { cookieHeader, principal, clock })
    assert.match(registered.fingerprint, /^[a-f0-9]{64}$/)
    assert.equal(registered.fingerprint, oidcSessionFingerprint(cookieHeader))
    assert.equal(await oidcSessionIsActive(store, { cookieHeader, principal, clock }), true)

    const summary = await oidcSessionRegistrySummary(store, { clock })
    assert.deepEqual(summary, { generation: 1, active: 1, revoked: 0 })
  })
})

test('logout-style revocation immediately invalidates the copied session cookie server-side', async () => {
  await withStore(async (store) => {
    const cookieHeader = sessionCookie()
    const clock = () => 1_800_000_100_000
    await registerOidcSession(store, { cookieHeader, principal, clock })

    const revoked = await revokeOidcSession(store, { cookieHeader, actor: principal.id, clock })
    assert.equal(revoked.revoked, true)
    assert.equal(await oidcSessionIsActive(store, { cookieHeader, principal, clock }), false)

    const summary = await oidcSessionRegistrySummary(store, { clock })
    assert.deepEqual(summary, { generation: 1, active: 0, revoked: 1 })
  })
})

test('admin revoke-all invalidates every active OIDC session and advances registry generation', async () => {
  await withStore(async (store) => {
    const clock = () => 1_800_000_100_000
    const first = sessionCookie({ id: 'oidc:user-1', subject: 'user-1' })
    const secondPrincipal = { ...principal, id: 'oidc:user-2', subject: 'user-2' }
    const second = sessionCookie({ id: secondPrincipal.id, subject: secondPrincipal.subject })

    await registerOidcSession(store, { cookieHeader: first, principal, clock })
    await registerOidcSession(store, { cookieHeader: second, principal: secondPrincipal, clock })
    const result = await revokeAllOidcSessions(store, { actor: 'oidc:admin', clock })

    assert.equal(result.revokedCount, 2)
    assert.equal(result.generation, 2)
    assert.equal(await oidcSessionIsActive(store, { cookieHeader: first, principal, clock }), false)
    assert.equal(await oidcSessionIsActive(store, { cookieHeader: second, principal: secondPrincipal, clock }), false)
    assert.deepEqual(await oidcSessionRegistrySummary(store, { clock }), { generation: 2, active: 0, revoked: 0 })
  })
})

test('registration rejects mismatched principals and expired sessions', async () => {
  await withStore(async (store) => {
    const clock = () => 1_800_000_100_000
    await assert.rejects(
      () => registerOidcSession(store, {
        cookieHeader: sessionCookie(),
        principal: { ...principal, id: 'oidc:other' },
        clock,
      }),
      /does not match/,
    )
    await assert.rejects(
      () => registerOidcSession(store, {
        cookieHeader: sessionCookie({ issuedAt: 1_799_990_000, expiresAt: 1_799_999_999 }),
        principal,
        clock,
      }),
      /already expired/,
    )
  })
})
