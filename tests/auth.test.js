import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeApiAccess, loadAuthConfig, requiredRole } from '../src/auth.js'

test('RBAC loads tokens by environment-variable reference without exposing raw config tokens', () => {
  const config = loadAuthConfig({
    BLOGGERS_RBAC_JSON: JSON.stringify([
      { id: 'reader', name: 'Reader', role: 'viewer', tokenEnv: 'VIEWER_TOKEN' },
      { id: 'editor', name: 'Editor', role: 'editor', tokenEnv: 'EDITOR_TOKEN' },
    ]),
    VIEWER_TOKEN: 'viewer-secret',
    EDITOR_TOKEN: 'editor-secret',
    BLOGGERS_ADMIN_TOKEN: 'admin-secret',
  })

  assert.equal(config.configured, true)
  assert.equal(config.principals.length, 3)
  assert.equal(config.principals.find((item) => item.id === 'reader').tokenEnv, 'VIEWER_TOKEN')
  assert.equal(config.principals.find((item) => item.id === 'legacy-admin').role, 'admin')
})

test('viewer can read but cannot run workflows', () => {
  const config = loadAuthConfig({
    BLOGGERS_RBAC_JSON: JSON.stringify([{ role: 'viewer', tokenEnv: 'VIEWER_TOKEN' }]),
    VIEWER_TOKEN: 'viewer-secret',
  })

  const read = authorizeApiAccess({
    method: 'GET',
    pathname: '/api/content',
    token: 'viewer-secret',
    loopback: false,
    config,
  })
  assert.equal(read.ok, true)
  assert.equal(read.role, 'viewer')

  const jobs = authorizeApiAccess({
    method: 'GET',
    pathname: '/api/jobs',
    token: 'viewer-secret',
    loopback: false,
    config,
  })
  assert.equal(jobs.ok, true)

  const mutate = authorizeApiAccess({
    method: 'POST',
    pathname: '/api/workflows/run',
    token: 'viewer-secret',
    loopback: false,
    config,
  })
  assert.equal(mutate.ok, false)
  assert.equal(mutate.status, 403)
  assert.equal(mutate.requiredRole, 'editor')
})

test('editor can pause automation but only admin can resume or change settings', () => {
  const config = loadAuthConfig({
    BLOGGERS_RBAC_JSON: JSON.stringify([{ role: 'editor', tokenEnv: 'EDITOR_TOKEN' }]),
    EDITOR_TOKEN: 'editor-secret',
  })

  assert.equal(authorizeApiAccess({ method: 'POST', pathname: '/api/system/pause', token: 'editor-secret', loopback: false, config }).ok, true)
  assert.equal(authorizeApiAccess({ method: 'POST', pathname: '/api/system/resume', token: 'editor-secret', loopback: false, config }).status, 403)
  assert.equal(authorizeApiAccess({ method: 'PATCH', pathname: '/api/settings/ai-budget', token: 'editor-secret', loopback: false, config }).status, 403)
  assert.equal(authorizeApiAccess({ method: 'GET', pathname: '/api/settings', token: 'editor-secret', loopback: false, config }).ok, true)
})

test('localhost remains admin only when no auth token is configured', () => {
  const config = loadAuthConfig({})
  const local = authorizeApiAccess({ method: 'POST', pathname: '/api/system/resume', token: '', loopback: true, config })
  const remote = authorizeApiAccess({ method: 'GET', pathname: '/api/hq', token: '', loopback: false, config })
  assert.equal(local.ok, true)
  assert.equal(local.role, 'admin')
  assert.equal(remote.ok, false)
  assert.equal(remote.status, 403)
})

test('route policy keeps mutations above viewer level', () => {
  assert.equal(requiredRole('GET', '/api/hq'), 'viewer')
  assert.equal(requiredRole('GET', '/api/jobs'), 'viewer')
  assert.equal(requiredRole('POST', '/api/blogs'), 'editor')
  assert.equal(requiredRole('PATCH', '/api/settings/scheduler'), 'admin')
})
