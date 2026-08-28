import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeApiAccess, loadAuthConfig } from '../src/auth.js'

test('verified session principals use the same viewer/editor/admin route policy', () => {
  const config = loadAuthConfig({})
  const viewer = { id: 'oidc:user-1', name: 'Viewer', role: 'viewer', authType: 'oidc' }
  const editor = { id: 'oidc:user-2', name: 'Editor', role: 'editor', authType: 'oidc' }

  const read = authorizeApiAccess({
    method: 'GET',
    pathname: '/api/content',
    token: '',
    principal: viewer,
    loopback: false,
    config,
  })
  assert.equal(read.ok, true)
  assert.equal(read.role, 'viewer')

  const blocked = authorizeApiAccess({
    method: 'POST',
    pathname: '/api/workflows/run',
    token: '',
    principal: viewer,
    loopback: false,
    config,
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 403)

  const allowed = authorizeApiAccess({
    method: 'POST',
    pathname: '/api/workflows/run',
    token: '',
    principal: editor,
    loopback: false,
    config,
  })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.principal.authType, 'oidc')
})

test('an explicitly presented invalid bearer token never falls back to a valid browser session', () => {
  const config = loadAuthConfig({ BLOGGERS_ADMIN_TOKEN: 'correct-token' })
  const sessionPrincipal = { id: 'oidc:admin', name: 'Session Admin', role: 'admin', authType: 'oidc' }
  const result = authorizeApiAccess({
    method: 'POST',
    pathname: '/api/system/resume',
    token: 'wrong-token',
    principal: sessionPrincipal,
    loopback: false,
    config,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
})
