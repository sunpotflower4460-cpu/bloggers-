// @feature F-006
// @feature F-008
// @feature F-012
import { createHash } from 'node:crypto'
import { DEFAULT_STATE } from './store.js'

export const SYSTEM_SECTIONS = ['core', 'aiBudget', 'scheduler']

function clone(value) {
  return structuredClone(value)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function hashVersion(value) {
  return `h:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('base64url')}`
}

function conflict(section, expectedVersion, currentVersion) {
  const error = new Error(`${section} settings changed in another session. Reload the latest settings before saving.`)
  error.code = 'SYSTEM_VERSION_CONFLICT'
  error.status = 409
  error.section = section
  error.expectedVersion = expectedVersion
  error.currentVersion = currentVersion
  return error
}

export function splitSystemSections(system = {}) {
  const normalized = {
    ...clone(DEFAULT_STATE.system),
    ...clone(system ?? {}),
    aiBudget: {
      ...clone(DEFAULT_STATE.system.aiBudget),
      ...clone(system?.aiBudget ?? {}),
    },
    scheduler: {
      ...clone(DEFAULT_STATE.system.scheduler),
      ...clone(system?.scheduler ?? {}),
      retryQueue: clone(system?.scheduler?.retryQueue ?? DEFAULT_STATE.system.scheduler.retryQueue),
    },
  }
  const { aiBudget, scheduler, ...core } = normalized
  return { core, aiBudget, scheduler }
}

export function mergeSystemSections(sections = {}, fallback = DEFAULT_STATE.system) {
  const base = splitSystemSections(fallback)
  return {
    ...base.core,
    ...(sections.core ?? {}),
    aiBudget: { ...base.aiBudget, ...(sections.aiBudget ?? {}) },
    scheduler: {
      ...base.scheduler,
      ...(sections.scheduler ?? {}),
      retryQueue: clone(sections.scheduler?.retryQueue ?? base.scheduler.retryQueue ?? []),
    },
  }
}

export function publicSystemView(system = {}) {
  const visible = clone(system ?? {})
  delete visible.oidcSessions
  return visible
}

function assertSection(section) {
  if (!SYSTEM_SECTIONS.includes(section)) throw new Error(`Unsupported system section: ${section}`)
}

export async function mutateSystemSection(store, section, mutator) {
  assertSection(section)
  if (typeof mutator !== 'function') throw new Error('system mutator must be a function')
  if (typeof store.systemMutate === 'function') return store.systemMutate(section, mutator)

  return store.mutate(async (state) => {
    const sections = splitSystemSections(state.system)
    const value = sections[section]
    const result = await mutator(value)
    state.system = mergeSystemSections(sections)
    return result === undefined ? clone(value) : result
  })
}

export async function readSystemSection(store, section) {
  assertSection(section)
  if (typeof store.systemRead === 'function') return store.systemRead(section)
  const state = await store.read()
  return splitSystemSections(state.system)[section]
}

export async function readSystemSectionVersion(store, section) {
  assertSection(section)
  if (typeof store.systemReadWithRevision === 'function') {
    const current = await store.systemReadWithRevision(section)
    return { value: current.value, version: `r:${current.revision}` }
  }
  const value = await readSystemSection(store, section)
  return { value, version: hashVersion(value) }
}

export async function mutateSystemSectionVersioned(store, section, expectedVersion, mutator) {
  assertSection(section)
  if (!expectedVersion) return mutateSystemSection(store, section, mutator)
  if (typeof mutator !== 'function') throw new Error('system mutator must be a function')

  if (typeof store.systemMutateVersioned === 'function' && String(expectedVersion).startsWith('r:')) {
    const expectedRevision = Number(String(expectedVersion).slice(2))
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Invalid system revision token')
    return store.systemMutateVersioned(section, expectedRevision, mutator)
  }

  return store.mutate(async (state) => {
    const sections = splitSystemSections(state.system)
    const value = sections[section]
    const currentVersion = hashVersion(value)
    if (currentVersion !== expectedVersion) throw conflict(section, expectedVersion, currentVersion)
    const result = await mutator(value)
    state.system = mergeSystemSections(sections)
    return result === undefined ? clone(value) : result
  })
}
