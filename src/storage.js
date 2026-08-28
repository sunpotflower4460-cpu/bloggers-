// @feature F-012
import { JsonStore } from './store.js'

export function storageMode(env = process.env) {
  const driver = String(env.BLOGGERS_STORAGE_DRIVER || 'json').trim().toLowerCase()
  if (driver === 'json') return { driver: 'json', transactionCapable: true, multiProcess: true, multiHost: false }
  if (driver === 'postgres') return { driver: 'postgres', transactionCapable: true, multiProcess: true, multiHost: true }
  return { driver, transactionCapable: false, multiProcess: false, multiHost: false }
}

export async function createStore({ env = process.env, postgresPool = null } = {}) {
  const mode = storageMode(env)
  if (mode.driver === 'json') return new JsonStore(env.BLOGGERS_DATA_FILE || './data/state.json').init()
  if (mode.driver === 'postgres') {
    if (!postgresPool) {
      throw new Error('PostgreSQL storage requires an injected postgresPool. The current no-new-dependencies foundation does not bundle a PostgreSQL driver.')
    }
    const { PostgresStore } = await import('./postgres-store.js')
    return new PostgresStore(postgresPool).init()
  }
  throw new Error(`Unsupported BLOGGERS_STORAGE_DRIVER: ${mode.driver}`)
}
