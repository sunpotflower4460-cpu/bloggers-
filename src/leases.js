// @feature F-012
import { createId, nowIso } from './store.js'

const DEFAULT_TTL_MS = 15 * 60 * 1000

function expired(lease, now) {
  return !lease.expiresAt || new Date(lease.expiresAt).getTime() <= now
}

function leaseLostError(key) {
  const error = new Error(`Operation lease ownership was lost: ${key}`)
  error.code = 'OPERATION_LEASE_LOST'
  return error
}

export async function acquireLease(store, key, { ttlMs = DEFAULT_TTL_MS, owner = createId('lease-owner'), now = Date.now() } = {}) {
  const acquiredAt = new Date(now).toISOString()
  const expiresAt = new Date(now + Math.max(1000, ttlMs)).toISOString()
  const leaseId = createId('lease')

  if (typeof store.leaseAcquire === 'function') {
    return store.leaseAcquire({ key, leaseId, owner, acquiredAt, expiresAt, now })
  }

  return store.mutate((state) => {
    state.locks ??= []
    state.locks = state.locks.filter((item) => !expired(item, now))
    const existing = state.locks.find((item) => item.key === key)
    if (existing) return { acquired: false, lease: structuredClone(existing), owner }

    const lease = {
      id: leaseId,
      key,
      owner,
      acquiredAt,
      expiresAt,
      updatedAt: nowIso(),
    }
    state.locks.push(lease)
    return { acquired: true, lease: structuredClone(lease), owner }
  })
}

export async function renewLease(store, key, owner, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!owner) throw new Error('Operation lease renewal requires an owner')
  if (store.capabilities?.nativeLeaseRenew && typeof store.leaseRenew === 'function') {
    return store.leaseRenew(key, owner, { ttlMs, now })
  }

  return store.mutate((state) => {
    state.locks ??= []
    const lease = state.locks.find((item) => item.key === key)
    if (!lease || lease.owner !== owner || expired(lease, now)) throw leaseLostError(key)
    lease.expiresAt = new Date(now + Math.max(1000, ttlMs)).toISOString()
    lease.updatedAt = nowIso()
    return structuredClone(lease)
  })
}

export async function releaseLease(store, key, owner) {
  if (typeof store.leaseRelease === 'function') return store.leaseRelease(key, owner)

  return store.mutate((state) => {
    state.locks ??= []
    const index = state.locks.findIndex((item) => item.key === key && item.owner === owner)
    if (index === -1) return false
    state.locks.splice(index, 1)
    return true
  })
}

export function summarizeLeases(state) {
  const now = Date.now()
  return (state.locks ?? []).filter((item) => !expired(item, now)).map((item) => ({
    key: item.key,
    acquiredAt: item.acquiredAt,
    expiresAt: item.expiresAt,
  }))
}
