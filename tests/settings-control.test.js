import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonStore } from '../src/store.js'
import {
  configureAiBudgetVersioned,
  configureSchedulerVersioned,
  settingsVersions,
} from '../src/settings-control.js'

async function withStore(work) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-settings-version-'))
  try {
    const store = await new JsonStore(join(dir, 'state.json')).init()
    return await work(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function isVersionConflict(error, section) {
  return error?.code === 'SYSTEM_VERSION_CONFLICT'
    && error?.status === 409
    && error?.section === section
}

test('JSON settings use content-hash versions and reject stale AI budget writes', async () => {
  await withStore(async (store) => {
    const initial = await settingsVersions(store)
    assert.match(initial.aiBudget, /^h:/)

    const saved = await configureAiBudgetVersioned(store, {
      monthlyUsd: 42,
      perCycleUsd: 3,
      reserveUsd: 1,
    }, { expectedVersion: initial.aiBudget })
    assert.equal(saved.monthlyUsd, 42)

    const afterFirstSave = await settingsVersions(store)
    assert.notEqual(afterFirstSave.aiBudget, initial.aiBudget)

    await assert.rejects(
      () => configureAiBudgetVersioned(store, { monthlyUsd: 99 }, { expectedVersion: initial.aiBudget }),
      (error) => isVersionConflict(error, 'aiBudget'),
    )

    const state = await store.read()
    assert.equal(state.system.aiBudget.monthlyUsd, 42)
    assert.equal((await settingsVersions(store)).aiBudget, afterFirstSave.aiBudget)
  })
})

test('JSON stale Scheduler tab cannot overwrite a newer Scheduler configuration', async () => {
  await withStore(async (store) => {
    const firstTab = await settingsVersions(store)
    const secondTab = await settingsVersions(store)
    assert.equal(secondTab.scheduler, firstTab.scheduler)

    const saved = await configureSchedulerVersioned(store, {
      enabled: true,
      intervalMinutes: 45,
      maxRetries: 3,
      retryDelayMinutes: 7,
    }, { expectedVersion: firstTab.scheduler, now: 1_800_000_000_000 })
    assert.equal(saved.enabled, true)
    assert.equal(saved.intervalMinutes, 45)

    await assert.rejects(
      () => configureSchedulerVersioned(store, {
        enabled: true,
        intervalMinutes: 15,
      }, { expectedVersion: secondTab.scheduler, now: 1_800_000_100_000 }),
      (error) => isVersionConflict(error, 'scheduler'),
    )

    const state = await store.read()
    assert.equal(state.system.scheduler.intervalMinutes, 45)
    assert.equal(state.system.scheduler.maxRetries, 3)
    assert.equal(state.system.scheduler.retryDelayMinutes, 7)
  })
})
