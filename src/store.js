// @feature F-012
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { assertPersistableSecretReferences } from './secrets.js'

const DEFAULT_STATE = {
  version: 5,
  system: {
    paused: false,
    pausedAt: null,
    lastCycleAt: null,
    defaultAutonomyLevel: 2,
    aiBudget: {
      enabled: true,
      monthlyUsd: 20,
      perCycleUsd: 2,
      reserveUsd: 0.5,
    },
    scheduler: {
      enabled: false,
      intervalMinutes: 360,
      maxRetries: 2,
      retryDelayMinutes: 10,
      lastRunAt: null,
      nextRunAt: null,
      running: false,
      retryQueue: [],
    },
  },
  blogs: [],
  ideas: [],
  articles: [],
  approvals: [],
  activities: [],
  analytics: [],
  experiments: [],
  workflows: [],
  memories: [],
  jobs: [],
  aiUsage: [],
  locks: [],
}

function clone(value) {
  return structuredClone(value)
}

export function normalizeState(value = {}) {
  return {
    ...clone(DEFAULT_STATE),
    ...value,
    version: Math.max(Number(value.version || 1), DEFAULT_STATE.version),
    system: {
      ...DEFAULT_STATE.system,
      ...(value.system ?? {}),
      aiBudget: {
        ...DEFAULT_STATE.system.aiBudget,
        ...(value.system?.aiBudget ?? {}),
      },
      scheduler: {
        ...DEFAULT_STATE.system.scheduler,
        ...(value.system?.scheduler ?? {}),
        retryQueue: value.system?.scheduler?.retryQueue ?? [],
      },
    },
    blogs: value.blogs ?? [],
    ideas: value.ideas ?? [],
    articles: value.articles ?? [],
    approvals: value.approvals ?? [],
    activities: value.activities ?? [],
    analytics: value.analytics ?? [],
    experiments: value.experiments ?? [],
    workflows: value.workflows ?? [],
    memories: value.memories ?? [],
    jobs: value.jobs ?? [],
    aiUsage: value.aiUsage ?? [],
    locks: value.locks ?? [],
  }
}

function envMs(name, fallback, min, max) {
  const parsed = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class JsonStore {
  #path
  #lockPath
  #queue = Promise.resolve()

  constructor(path = process.env.BLOGGERS_DATA_FILE || './data/state.json') {
    this.#path = resolve(path)
    this.#lockPath = `${this.#path}.lock`
  }

  get backend() {
    return 'json'
  }

  async init() {
    await mkdir(dirname(this.#path), { recursive: true })
    await this.#withProcessLock(async () => {
      try {
        await readFile(this.#path, 'utf8')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await this.#write(DEFAULT_STATE)
      }
    })
    return this
  }

  async read() {
    const text = await readFile(this.#path, 'utf8')
    return normalizeState(JSON.parse(text))
  }

  async transaction(mutator) {
    return this.mutate(mutator)
  }

  async mutate(mutator) {
    const task = this.#queue.then(() => this.#withProcessLock(async () => {
      const state = await this.read()
      const result = await mutator(state)
      await this.#write(state)
      return result
    }))
    this.#queue = task.catch(() => undefined)
    return task
  }

  async #withProcessLock(work) {
    const owner = `${process.pid}:${randomUUID()}`
    const ownerPath = `${this.#lockPath}/owner`
    const timeoutMs = envMs('BLOGGERS_JSON_LOCK_TIMEOUT_MS', 10_000, 500, 120_000)
    const staleMs = envMs('BLOGGERS_JSON_STALE_LOCK_MS', 300_000, 10_000, 3_600_000)
    const deadline = Date.now() + timeoutMs
    let acquired = false

    while (!acquired) {
      try {
        await mkdir(this.#lockPath)
        try {
          await writeFile(ownerPath, owner, 'utf8')
          acquired = true
        } catch (error) {
          await rm(this.#lockPath, { recursive: true, force: true })
          throw error
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try {
          const info = await stat(this.#lockPath)
          if (Date.now() - info.mtimeMs > staleMs) {
            await rm(this.#lockPath, { recursive: true, force: true })
            continue
          }
        } catch (statError) {
          if (statError.code === 'ENOENT') continue
          throw statError
        }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for JSON store transaction lock')
        await sleep(25)
      }
    }

    try {
      return await work()
    } finally {
      try {
        const currentOwner = await readFile(ownerPath, 'utf8')
        if (currentOwner === owner) await rm(this.#lockPath, { recursive: true, force: true })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }

  async #write(state) {
    assertPersistableSecretReferences(state)
    const temp = `${this.#path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temp, this.#path)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

export function nowIso() {
  return new Date().toISOString()
}

export { DEFAULT_STATE }
