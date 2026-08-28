// @feature F-003
// @feature F-007
// @feature F-009
// @feature F-012

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/
const MANAGED_KEY = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/

let managedResolver = null
let managedResolverLabel = null

function clean(value) {
  return String(value ?? '').trim()
}

export function normalizeSecretReference(reference) {
  const raw = clean(reference)
  if (!raw) return null

  if (!raw.includes(':')) {
    if (!ENV_NAME.test(raw)) {
      throw new Error('Secret references must be environment-variable names or explicit env:/managed: references')
    }
    return { provider: 'env', key: raw, reference: `env:${raw}` }
  }

  const separator = raw.indexOf(':')
  const provider = raw.slice(0, separator).toLowerCase()
  const key = raw.slice(separator + 1)
  if (provider === 'env') {
    if (!ENV_NAME.test(key)) throw new Error('env: secret references must contain a valid environment-variable name')
    return { provider, key, reference: `env:${key}` }
  }
  if (provider === 'managed') {
    if (!MANAGED_KEY.test(key)) throw new Error('managed: secret references contain an invalid key')
    return { provider, key, reference: `managed:${key}` }
  }
  throw new Error(`Unsupported secret reference provider: ${provider}`)
}

function normalizeManagedResolver(module, env) {
  if (typeof module.createSecretResolver === 'function') {
    return Promise.resolve(module.createSecretResolver({ env })).then((resolver) => ({ resolver, label: 'createSecretResolver' }))
  }
  if (module.resolver) return Promise.resolve({ resolver: module.resolver, label: 'resolver' })
  if (module.default) return Promise.resolve({ resolver: module.default, label: 'default' })
  throw new Error('Secret provider module must export createSecretResolver(), resolver, or a default resolver')
}

function assertResolver(resolver) {
  if (typeof resolver === 'function') return resolver
  if (resolver && typeof resolver.resolve === 'function') return (key) => resolver.resolve(key)
  throw new Error('Managed secret resolver must be a function or expose resolve(key)')
}

export async function initializeSecretResolver({
  env = process.env,
  importer = (specifier) => import(specifier),
} = {}) {
  const specifier = clean(env.BLOGGERS_SECRET_PROVIDER_MODULE)
  if (!specifier) {
    managedResolver = null
    managedResolverLabel = null
    return { mode: 'env-only', configured: false }
  }

  const module = await importer(specifier)
  const loaded = await normalizeManagedResolver(module, env)
  managedResolver = assertResolver(loaded.resolver)
  managedResolverLabel = specifier
  return { mode: 'env+managed', configured: true, module: specifier, exportType: loaded.label }
}

export function secretResolverStatus() {
  return {
    env: true,
    managed: Boolean(managedResolver),
    managedModule: managedResolverLabel,
  }
}

export function resolveSecret(reference, { env = process.env, required = false, label = 'Secret' } = {}) {
  const normalized = normalizeSecretReference(reference)
  if (!normalized) {
    if (required) throw new Error(`${label} reference is required`)
    return null
  }

  let value = null
  if (normalized.provider === 'env') {
    value = clean(env[normalized.key])
    if (!value && required) throw new Error(`${label} environment variable is missing: ${normalized.key}`)
  } else if (normalized.provider === 'managed') {
    if (!managedResolver) {
      if (required) throw new Error(`${label} requires a managed secret resolver: ${normalized.reference}`)
      return null
    }
    const resolved = managedResolver(normalized.key)
    if (resolved && typeof resolved.then === 'function') {
      throw new Error('Managed secret resolver returned a Promise at runtime. Load/cache secrets inside createSecretResolver() so resolve(key) is synchronous.')
    }
    value = clean(resolved)
    if (!value && required) throw new Error(`${label} managed secret is missing: ${normalized.key}`)
  }

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
