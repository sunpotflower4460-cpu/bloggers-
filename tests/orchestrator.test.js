import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/store.js'
import { RuleBasedProvider } from '../src/ai.js'
import { addBlog, resolveApproval, runBlogCycle, setPaused, summarizeHQ } from '../src/orchestrator.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a blog can be registered with an isolated Blog Brain', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Music Lab',
      brain: {
        purpose: '宅録の判断を助ける',
        audience: '宅録初心者',
        voice: '静かで具体的',
        topics: ['録音', 'ミックス'],
      },
      connector: { type: 'memory' },
      autonomy: { level: 2 },
    })
    const state = await store.read()
    assert.equal(state.blogs.length, 1)
    assert.equal(state.blogs[0].id, blog.id)
    assert.deepEqual(state.blogs[0].brain.topics, ['録音', 'ミックス'])
  })
})

test('an editorial cycle observes, decides and creates a draft', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'AI Journal',
      brain: { purpose: 'AI活用を検証する', topics: ['AI初心者'] },
      connector: { type: 'memory' },
      autonomy: { level: 2, allowCreate: true, allowPublish: false },
    })
    const result = await runBlogCycle(store, blog.id, { provider: new RuleBasedProvider() })
    const state = await store.read()
    assert.equal(result.decision.action, 'CREATE')
    assert.equal(state.articles.length, 1)
    assert.equal(state.articles[0].status, 'draft')
    assert.equal(state.experiments.length, 0, 'experiment should start only after the change is live')
    assert.ok(state.activities.some((item) => item.type === 'cycle.decide'))
  })
})

test('an approved revision updates the existing remote post and starts measurement', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Update Journal',
      brain: { purpose: 'AI活用を検証する', topics: ['AI初心者'] },
      connector: { type: 'memory' },
      autonomy: { level: 2, allowCreate: true, allowUpdate: true, allowPublish: false },
    })
    await store.mutate((state) => {
      const saved = state.blogs.find((item) => item.id === blog.id)
      saved.remotePosts.push({
        id: 'remote_existing',
        title: 'AI初心者のための最初のガイド',
        content: '古い本文',
        status: 'publish',
      })
    })

    const result = await runBlogCycle(store, blog.id, { provider: new RuleBasedProvider() })
    assert.equal(result.decision.action, 'UPDATE')
    assert.equal(result.article.status, 'draft-update')
    assert.equal(result.approval.action, 'UPDATE')

    const resolved = await resolveApproval(store, result.approval.id, true)
    const state = await store.read()
    const remote = state.blogs[0].remotePosts.find((item) => item.id === 'remote_existing')
    const article = state.articles.find((item) => item.id === result.article.id)

    assert.equal(resolved.updated, true)
    assert.equal(article.status, 'published')
    assert.match(remote.content, /更新メモ/)
    assert.equal(state.experiments.length, 1)
    assert.equal(state.experiments[0].action, 'UPDATE')
  })
})

test('the emergency brake prevents autonomous cycles', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, { name: 'Paused Blog', connector: { type: 'memory' } })
    await setPaused(store, true)
    const result = await runBlogCycle(store, blog.id, { provider: new RuleBasedProvider() })
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'system-paused')
    assert.equal(summarizeHQ(await store.read()).system.paused, true)
  })
})
