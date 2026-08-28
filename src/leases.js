// @feature F-012
import { createId, nowIso } from './store.js'

const DEFAULT_TTL_MS = 15 * 60 * 1000

function expired(lease, now) {
  return !lease.expiresAt || new Date(lease.expiresAt).getTime() <= now
}

export async function acquireLease(store, key, { ttlMs = DEFAULT_TTL_MS, owner = createId('lease-owner'), now = Date.now() } = {}) {
  return store.mutate((state) => {
    state.locks ??= []
    state.locks = state.locks.filter((item) => !expired(item, now))
    const existing = state.locks.find((item) => item.key === key)
    if (existing) return { acquired: false, lease: structuredClone(existing), owner }

    const lease = {
      id: createId('lease'),
      key,
      owner,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.max(1000, ttlMs)).toISOString(),
      updatedAt: nowIso(),
    }
    state.locks.push(lease)
    return { acquired: true, lease: structuredClone(lease), owner }
  })
}

export async function releaseLease(store, key, owner) {
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
