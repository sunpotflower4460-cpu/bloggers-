// @feature F-012
import { PostgresStore } from './postgres-store.js'

function iso(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export class PostgresRuntimeStore extends PostgresStore {
  #runtimePool

  constructor(pool) {
    super(pool)
    this.#runtimePool = pool
  }

  get capabilities() {
    return { ...super.capabilities, nativeLeaseRenew: true }
  }

  async leaseRenew(key, owner, { ttlMs, now = Date.now() } = {}) {
    if (!owner) throw new Error('Operation lease renewal requires an owner')
    const duration = Math.max(1000, Number(ttlMs || 0))
    const updatedAt = new Date(now).toISOString()
    const expiresAt = new Date(now + duration).toISOString()
    const result = await this.#runtimePool.query(
      `UPDATE bloggers_operation_leases
       SET expires_at = $4::timestamptz, updated_at = $3::timestamptz
       WHERE lease_key = $1 AND owner = $2 AND expires_at > $3::timestamptz
       RETURNING lease_key, lease_id, owner, acquired_at, expires_at, updated_at`,
      [key, owner, updatedAt, expiresAt],
    )
    const row = result.rows?.[0]
    if (!row) {
      const error = new Error(`Operation lease ownership was lost: ${key}`)
      error.code = 'OPERATION_LEASE_LOST'
      throw error
    }
    return {
      id: row.lease_id,
      key: row.lease_key,
      owner: row.owner,
      acquiredAt: iso(row.acquired_at),
      expiresAt: iso(row.expires_at),
      updatedAt: iso(row.updated_at),
    }
  }
}
