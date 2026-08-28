// @feature F-004
// @feature F-012
import { createHash } from 'node:crypto'

export function stableId(prefix, key) {
  const cleanPrefix = String(prefix || 'id').trim() || 'id'
  const cleanKey = String(key || '').trim()
  if (!cleanKey) return null
  const digest = createHash('sha256').update(`${cleanPrefix}:${cleanKey}`).digest('hex').slice(0, 24)
  return `${cleanPrefix}_${digest}`
}
