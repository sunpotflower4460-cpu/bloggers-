// @feature F-012
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const DEFAULT_STATE = {
  version: 4,
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

function mergeDefaults(value = {}) {
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

export class JsonStore {
  #path
  #queue = Promise.resolve()

  constructor(path = process.env.BLOGGERS_DATA_FILE || './data/state.json') {
    this.#path = resolve(path)
  }

  async init() {
    await mkdir(dirname(this.#path), { recursive: true })
    try {
      await readFile(this.#path, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await this.#write(DEFAULT_STATE)
    }
    return this
  }

  async read() {
    const text = await readFile(this.#path, 'utf8')
    return mergeDefaults(JSON.parse(text))
  }

  async mutate(mutator) {
    const task = this.#queue.then(async () => {
      const state = await this.read()
      const result = await mutator(state)
      await this.#write(state)
      return result
    })
    this.#queue = task.catch(() => undefined)
    return task
  }

  async #write(state) {
    const temp = `${this.#path}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temp, this.#path)
  }
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

export function nowIso() {
  return new Date().toISOString()
}

export { DEFAULT_STATE }
