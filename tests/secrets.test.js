import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initializeSecretResolver,
  normalizeSecretReference,
  resolveSecret,
  secretResolverStatus,
} from '../src/secrets.js'
import { JsonStore } from '../src/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-secrets-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('secret resolver accepts env references and resolves from injected environment', () => {
  assert.deepEqual(normalizeSecretReference('env:WP_PASSWORD'), {
    provider: 'env',
    key: 'WP_PASSWORD',
    reference: 'env:WP_PASSWORD',
  })
  assert.equal(resolveSecret('WP_PASSWORD', { env: { WP_PASSWORD: 'secret-value' } }), 'secret-value')
})

test('secret resolver accepts managed references without treating them as literal secrets', () => {
  assert.deepEqual(normalizeSecretReference('managed:blogs/music/wp-password'), {
    provider: 'managed',
    key: 'blogs/music/wp-password',
    reference: 'managed:blogs/music/wp-password',
  })
})

test('managed resolver module may preload asynchronously and resolve synchronously at runtime', async () => {
  const status = await initializeSecretResolver({
    env: { BLOGGERS_SECRET_PROVIDER_MODULE: 'managed-test-provider' },
    importer: async (specifier) => {
      assert.equal(specifier, 'managed-test-provider')
      return {
        async createSecretResolver() {
          await Promise.resolve()
          const cache = new Map([['blogs/music/wp-password', 'managed-secret-value']])
          return (key) => cache.get(key) || null
        },
      }
    },
  })

  assert.equal(status.configured, true)
  assert.equal(secretResolverStatus().managed, true)
  assert.equal(resolveSecret('managed:blogs/music/wp-password', { required: true }), 'managed-secret-value')
  await initializeSecretResolver({ env: {} })
})

test('managed runtime resolver must not return a Promise after startup', async () => {
  await initializeSecretResolver({
    env: { BLOGGERS_SECRET_PROVIDER_MODULE: 'bad-managed-provider' },
    importer: async () => ({ resolver: async () => 'late-secret' }),
  })
  assert.throws(
    () => resolveSecret('managed:blogs/music/wp-password', { required: true }),
    /returned a Promise at runtime/,
  )
  await initializeSecretResolver({ env: {} })
})

test('secret resolver rejects literal secret-looking references', () => {
  assert.throws(() => normalizeSecretReference('xxxx xxxx xxxx xxxx'), /environment-variable names/)
  assert.throws(() => normalizeSecretReference('sk-proj-secret-value'), /environment-variable names/)
})

test('JsonStore rejects literal secrets in fields intended to contain secret references', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => store.mutate((state) => {
        state.blogs.push({
          id: 'blog-secret-test',
          name: 'Secret Test',
          connector: {
            type: 'wordpress',
            endpoint: 'https://example.com',
            usernameEnv: 'WP_USER',
            passwordEnv: 'actual password value',
          },
        })
      }),
      /state\.blogs\[0\]\.connector\.passwordEnv/,
    )

    const state = await store.read()
    assert.equal(state.blogs.length, 0)
  })
})

test('JsonStore accepts valid env and managed secret references', async () => {
  await withStore(async (store) => {
    await store.mutate((state) => {
      state.blogs.push({
        id: 'blog-safe-secret-ref',
        name: 'Safe Secret Ref',
        connector: {
          type: 'wordpress',
          endpoint: 'https://example.com',
          usernameEnv: 'WP_USER',
          passwordEnv: 'managed:blogs/music/wp-password',
        },
      })
    })
    const state = await store.read()
    assert.equal(state.blogs[0].connector.passwordEnv, 'managed:blogs/music/wp-password')
  })
})
