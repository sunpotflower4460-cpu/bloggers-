import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLease, releaseLease, renewLease } from '../src/leases.js'
import { addBlog } from '../src/orchestrator.js'
import { runBlogCycleExclusive } from '../src/runtime.js'
import { JsonStore } from '../src/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-runtime-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('only one editorial cycle may run for the same blog at a time', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Exclusive Blog',
      brain: { topics: ['運用'] },
      connector: { type: 'memory' },
      autonomy: { level: 2, allowCreate: true },
    })

    let releaseDecision
    const gate = new Promise((resolve) => { releaseDecision = resolve })
    const provider = {
      name: 'test-provider',
      drainUsage() { return [] },
      async decide() {
        await gate
        return { action: 'WAIT', topic: '運用', title: '', rationale: 'test', confidence: 1 }
      },
    }

    const first = runBlogCycleExclusive(store, blog.id, { provider })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await assert.rejects(
      () => runBlogCycleExclusive(store, blog.id, { provider }),
      /already has an editorial cycle/,
    )

    releaseDecision()
    const result = await first
    assert.equal(result.decision.action, 'WAIT')
    assert.equal((await store.read()).locks.length, 0)
  })
})

test('operation lease renewal extends ownership and fences other owners', async () => {
  await withStore(async (store) => {
    const first = await acquireLease(store, 'blog-cycle:b1', { owner: 'worker-a', ttlMs: 1000, now: 1000 })
    assert.equal(first.acquired, true)

    const renewed = await renewLease(store, 'blog-cycle:b1', 'worker-a', { ttlMs: 1000, now: 1500 })
    assert.equal(renewed.expiresAt, new Date(2500).toISOString())

    const blocked = await acquireLease(store, 'blog-cycle:b1', { owner: 'worker-b', ttlMs: 1000, now: 2200 })
    assert.equal(blocked.acquired, false)

    await assert.rejects(
      () => renewLease(store, 'blog-cycle:b1', 'worker-b', { ttlMs: 1000, now: 2200 }),
      (error) => error?.code === 'OPERATION_LEASE_LOST',
    )

    const reclaimed = await acquireLease(store, 'blog-cycle:b1', { owner: 'worker-b', ttlMs: 1000, now: 2600 })
    assert.equal(reclaimed.acquired, true)
    assert.equal(await releaseLease(store, 'blog-cycle:b1', 'worker-b'), true)
  })
})

test('expired operation leases can be reclaimed safely', async () => {
  await withStore(async (store) => {
    const first = await acquireLease(store, 'blog-cycle:b1', { owner: 'worker-a', ttlMs: 1000, now: 1000 })
    assert.equal(first.acquired, true)

    const blocked = await acquireLease(store, 'blog-cycle:b1', { owner: 'worker-b', ttlMs: 1000, now: 1500 })
    assert.equal(blocked.acquired, false)

    const reclaimed = await acquireLease(store, 'blog-cycle:b1', { owner: 'worker-b', ttlMs: 1000, now: 2500 })
    assert.equal(reclaimed.acquired, true)
    assert.equal(await releaseLease(store, 'blog-cycle:b1', 'worker-b'), true)
  })
})
