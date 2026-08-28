import test from 'node:test'
import assert from 'node:assert/strict'
import { PostgresRuntimeStore } from '../src/postgres-runtime-store.js'

function fakeLeasePool() {
  const row = {
    lease_key: 'blog-cycle:b1',
    lease_id: 'lease-1',
    owner: 'worker-a',
    acquired_at: '2026-08-28T00:00:00.000Z',
    expires_at: '2026-08-28T00:10:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
  }
  return {
    async connect() { return { query: this.query, release() {} } },
    async query(sql, params = []) {
      const command = String(sql).replace(/\s+/g, ' ').trim()
      if (!/^UPDATE bloggers_operation_leases/i.test(command)) throw new Error(`Unexpected SQL: ${command}`)
      const [key, owner, updatedAt, expiresAt] = params
      if (row.lease_key !== key || row.owner !== owner || new Date(row.expires_at).getTime() <= new Date(updatedAt).getTime()) {
        return { rows: [] }
      }
      row.expires_at = expiresAt
      row.updated_at = updatedAt
      return { rows: [{ ...row }] }
    },
  }
}

test('Postgres runtime renews an owned operation lease atomically', async () => {
  const store = new PostgresRuntimeStore(fakeLeasePool())
  const renewed = await store.leaseRenew('blog-cycle:b1', 'worker-a', {
    now: Date.parse('2026-08-28T00:05:00.000Z'),
    ttlMs: 15 * 60 * 1000,
  })
  assert.equal(store.capabilities.nativeLeaseRenew, true)
  assert.equal(renewed.owner, 'worker-a')
  assert.equal(renewed.expiresAt, '2026-08-28T00:20:00.000Z')
})

test('Postgres runtime rejects operation lease renewal from a stale owner', async () => {
  const store = new PostgresRuntimeStore(fakeLeasePool())
  await assert.rejects(
    () => store.leaseRenew('blog-cycle:b1', 'worker-b', {
      now: Date.parse('2026-08-28T00:05:00.000Z'),
      ttlMs: 15 * 60 * 1000,
    }),
    (error) => error?.code === 'OPERATION_LEASE_LOST',
  )
})
