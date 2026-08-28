// @feature F-003
// @feature F-007
// @feature F-009
// @feature F-012

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/

function clean(value) {
  return String(value ?? '').trim()
}

export function normalizeSecretReference(reference) {
  const raw = clean(reference)
  if (!raw) return null
  const name = raw.startsWith('env:') ? raw.slice(4) : raw
  if (!ENV_NAME.test(name)) {
    throw new Error('Secret references must be environment-variable names such as WP_SITE_PASSWORD')
  }
  return { provider: 'env', key: name, reference: `env:${name}` }
}

export function resolveSecret(reference, { env = process.env, required = false, label = 'Secret' } = {}) {
  const normalized = normalizeSecretReference(reference)
  if (!normalized) {
    if (required) throw new Error(`${label} reference is required`)
    return null
  }
  const value = clean(env[normalized.key])
  if (!value && required) throw new Error(`${label} environment variable is missing: ${normalized.key}`)
  return value || null
}

export function isSecretReferenceField(key) {
  return /(?:Env|SecretRef|TokenRef|PasswordRef)$/.test(String(key || ''))
}

export function assertPersistableSecretReferences(value, path = 'state') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPersistableSecretReferences(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (isSecretReferenceField(key) && typeof child === 'string' && child.trim()) {
      try {
        normalizeSecretReference(child)
      } catch (error) {
        throw new Error(`${path}.${key}: ${error.message}`)
      }
    }
    assertPersistableSecretReferences(child, `${path}.${key}`)
  }
}
