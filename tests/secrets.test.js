import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSecretReference, resolveSecret } from '../src/secrets.js'
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

test('secret resolver rejects literal secret-looking references', () => {
  assert.throws(() => normalizeSecretReference('xxxx xxxx xxxx xxxx'), /environment-variable names/)
  assert.throws(() => normalizeSecretReference('sk-proj-secret-value'), /environment-variable names/)
})

test('JsonStore rejects literal secrets in fields intended to contain env references', async () => {
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

test('JsonStore accepts valid environment-variable references', async () => {
  await withStore(async (store) => {
    await store.mutate((state) => {
      state.blogs.push({
        id: 'blog-safe-secret-ref',
        name: 'Safe Secret Ref',
        connector: {
          type: 'wordpress',
          endpoint: 'https://example.com',
          usernameEnv: 'WP_USER',
          passwordEnv: 'WP_PASSWORD',
        },
      })
    })
    const state = await store.read()
    assert.equal(state.blogs[0].connector.passwordEnv, 'WP_PASSWORD')
  })
})
