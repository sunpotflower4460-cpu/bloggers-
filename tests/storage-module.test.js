import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfiguredPostgresPool } from '../src/storage.js'

test('configured PostgreSQL pool module may expose createPool without bundling a driver', async () => {
  const expectedPool = { connect() {}, query() {} }
  let receivedEnv = null
  const pool = await loadConfiguredPostgresPool({
    env: { BLOGGERS_POSTGRES_POOL_MODULE: 'deployment-postgres-pool', DATABASE_URL: 'postgres://example' },
    importer: async (specifier) => {
      assert.equal(specifier, 'deployment-postgres-pool')
      return {
        async createPool({ env }) {
          receivedEnv = env
          return expectedPool
        },
      }
    },
  })
  assert.equal(pool, expectedPool)
  assert.equal(receivedEnv.DATABASE_URL, 'postgres://example')
})

test('configured PostgreSQL pool module rejects an invalid pool contract', async () => {
  await assert.rejects(
    () => loadConfiguredPostgresPool({
      env: { BLOGGERS_POSTGRES_POOL_MODULE: 'bad-pool' },
      importer: async () => ({ default: { connect() {} } }),
    }),
    /connect\(\) and query\(\)/,
  )
})
