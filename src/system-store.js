// @feature F-006
// @feature F-008
// @feature F-012
import { DEFAULT_STATE } from './store.js'

export const SYSTEM_SECTIONS = ['core', 'aiBudget', 'scheduler']

function clone(value) {
  return structuredClone(value)
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
