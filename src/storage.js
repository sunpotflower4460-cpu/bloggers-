// @feature F-012
import { JsonStore } from './store.js'

export function storageMode(env = process.env) {
  const driver = String(env.BLOGGERS_STORAGE_DRIVER || 'json').trim().toLowerCase()
  if (driver === 'json') return { driver: 'json', transactionCapable: true, multiProcess: true, multiHost: false }
  if (driver === 'postgres') return { driver: 'postgres', transactionCapable: true, multiProcess: true, multiHost: true }
  return { driver, transactionCapable: false, multiProcess: false, multiHost: false }
}

function assertPostgresPool(pool) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new Error('PostgreSQL pool must provide connect() and query()')
  }
  return pool
}

export async function loadConfiguredPostgresPool({
  env = process.env,
  importer = (specifier) => import(specifier),
} = {}) {
  const specifier = String(env.BLOGGERS_POSTGRES_POOL_MODULE || '').trim()
  if (!specifier) {
    throw new Error('PostgreSQL storage requires an injected postgresPool or BLOGGERS_POSTGRES_POOL_MODULE. No PostgreSQL driver is bundled by this no-new-dependencies foundation.')
  }

  const module = await importer(specifier)
  const pool = typeof module.createPool === 'function'
    ? await module.createPool({ env })
    : module.pool ?? module.default
  return assertPostgresPool(pool)
}

export async function createStore({ env = process.env, postgresPool = null, importer } = {}) {
  const mode = storageMode(env)
  if (mode.driver === 'json') return new JsonStore(env.BLOGGERS_DATA_FILE || './data/state.json').init()
  if (mode.driver === 'postgres') {
    const pool = postgresPool
      ? assertPostgresPool(postgresPool)
      : await loadConfiguredPostgresPool({ env, importer })
    const { PostgresConfigStore } = await import('./postgres-config-store.js')
    return new PostgresConfigStore(pool).init()
  }
  throw new Error(`Unsupported BLOGGERS_STORAGE_DRIVER: ${mode.driver}`)
}
