// @feature F-005
// @feature F-006
// @feature F-012
import { normalizeAiBudget } from './cost.js'
import { normalizeSchedulerConfig } from './scheduler.js'
import { mutateSystemSectionVersioned, readSystemSectionVersion } from './system-store.js'

function nextRunAt(intervalMinutes, from = Date.now()) {
  return new Date(from + intervalMinutes * 60 * 1000).toISOString()
}

export async function settingsVersions(store) {
  const [aiBudget, scheduler] = await Promise.all([
    readSystemSectionVersion(store, 'aiBudget'),
    readSystemSectionVersion(store, 'scheduler'),
  ])
  return {
    aiBudget: aiBudget.version,
    scheduler: scheduler.version,
  }
}

export async function configureAiBudgetVersioned(store, changes = {}, { expectedVersion = null } = {}) {
  return mutateSystemSectionVersioned(store, 'aiBudget', expectedVersion, (budget) => {
    const next = normalizeAiBudget({ ...budget, ...changes })
    for (const key of Object.keys(budget)) delete budget[key]
    Object.assign(budget, next)
    return structuredClone(next)
  })
}

export async function configureSchedulerVersioned(store, changes = {}, { expectedVersion = null, now = Date.now() } = {}) {
  return mutateSystemSectionVersioned(store, 'scheduler', expectedVersion, (scheduler) => {
    const current = normalizeSchedulerConfig(scheduler)
    const next = normalizeSchedulerConfig({ ...current, ...changes })
    if (next.enabled && (!current.enabled || changes.intervalMinutes !== undefined || !next.nextRunAt)) {
      next.nextRunAt = nextRunAt(next.intervalMinutes, now)
    }
    if (!next.enabled) next.nextRunAt = null
    for (const key of Object.keys(scheduler)) delete scheduler[key]
    Object.assign(scheduler, next)
    return structuredClone(next)
  })
}
