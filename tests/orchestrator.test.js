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

class CountingProvider extends RuleBasedProvider {
  constructor() {
    super()
    this.decideCalls = 0
    this.draftCalls = 0
    this.reviseCalls = 0
  }

  async decide(args) {
    this.decideCalls += 1
    return super.decide(args)
  }

  async draft(args) {
    this.draftCalls += 1
    return super.draft(args)
  }

  async revise(args) {
    this.reviseCalls += 1
    return super.revise(args)
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

test('a completed idempotent cycle is resumed without duplicate AI calls or editorial entities', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Retry Safe Journal',
      brain: { purpose: '再試行を安全にする', topics: ['AI初心者'] },
      connector: { type: 'memory' },
      autonomy: { level: 2, allowCreate: true, allowPublish: false },
    })
    const provider = new CountingProvider()
    const key = 'job:stable-cycle-1'

    const first = await runBlogCycle(store, blog.id, { provider, idempotencyKey: key, trigger: 'scheduler' })
    const afterFirst = await store.read()
    const callsAfterFirst = { decide: provider.decideCalls, draft: provider.draftCalls }

    const second = await runBlogCycle(store, blog.id, { provider, idempotencyKey: key, trigger: 'retry' })
    const afterSecond = await store.read()

    assert.equal(first.workflowId, second.workflowId)
    assert.equal(second.resumed, true)
    assert.deepEqual({ decide: provider.decideCalls, draft: provider.draftCalls }, callsAfterFirst)
    assert.equal(afterFirst.workflows.length, 1)
    assert.equal(afterSecond.workflows.length, 1)
    assert.equal(afterSecond.ideas.length, 1)
    assert.equal(afterSecond.articles.length, 1)
    assert.equal(afterSecond.approvals.length, 1)
    assert.equal(afterSecond.articles[0].id, afterFirst.articles[0].id)
    assert.equal(afterSecond.approvals[0].id, afterFirst.approvals[0].id)
  })
})

test('a retry after remote draft side effect reuses the same article and publishes only one remote post', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Crash Recovery Journal',
      brain: { purpose: 'remote side effectを安全に再開する', topics: ['AI初心者'] },
      connector: { type: 'memory' },
      autonomy: { level: 4, allowCreate: true, allowPublish: true },
    })
    const provider = new CountingProvider()
    const remotes = new Map()
    let crashOnce = true
    let createCalls = 0
    let publishCalls = 0

    const connector = {
      async listPosts() {
        return [...remotes.values()].map((item) => ({ ...item }))
      },
      async getMetrics() {
        return {
          posts: remotes.size,
          published: [...remotes.values()].filter((item) => item.status === 'publish').length,
        }
      },
      async createDraft(article) {
        createCalls += 1
        let remote = remotes.get(article.id)
        if (!remote) {
          remote = {
            id: `remote-${article.id}`,
            title: article.title,
            content: article.body,
            status: 'draft',
          }
          remotes.set(article.id, remote)
        }
        if (crashOnce) {
          crashOnce = false
          throw new Error('simulated disconnect after remote draft creation')
        }
        return { ...remote }
      },
      async publishPost(remoteId) {
        publishCalls += 1
        const remote = [...remotes.values()].find((item) => item.id === remoteId)
        if (!remote) throw new Error('remote not found')
        remote.status = 'publish'
        return { ...remote }
      },
      async updatePost() {
        throw new Error('unexpected update')
      },
    }

    const key = 'job:crash-recovery-1'
    await assert.rejects(
      () => runBlogCycle(store, blog.id, { provider, connector, idempotencyKey: key, trigger: 'scheduler' }),
      /simulated disconnect/,
    )
    const failedState = await store.read()
    assert.equal(failedState.articles.length, 1)
    assert.equal(failedState.articles[0].status, 'draft')
    assert.equal(failedState.ideas.length, 1)
    assert.equal(failedState.workflows.length, 1)
    assert.equal(failedState.workflows[0].status, 'failed')
    assert.equal(remotes.size, 1)
    assert.equal(provider.decideCalls, 1)
    assert.equal(provider.draftCalls, 1)

    const recovered = await runBlogCycle(store, blog.id, { provider, connector, idempotencyKey: key, trigger: 'retry' })
    const finalState = await store.read()

    assert.equal(recovered.resumed, true)
    assert.equal(remotes.size, 1, 'retry must not create a second remote draft')
    assert.equal(createCalls, 2, 'retry may look up/reuse the same remote draft once')
    assert.equal(publishCalls, 1)
    assert.equal(provider.decideCalls, 1, 'stored Director decision should be reused')
    assert.equal(provider.draftCalls, 1, 'stored local draft should be reused')
    assert.equal(finalState.ideas.length, 1)
    assert.equal(finalState.articles.length, 1)
    assert.equal(finalState.articles[0].status, 'published')
    assert.equal(finalState.articles[0].remoteId, [...remotes.values()][0].id)
    assert.equal(finalState.experiments.length, 1)
    assert.equal([...remotes.values()][0].status, 'publish')
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
