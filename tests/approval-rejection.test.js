import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuleBasedProvider } from '../src/ai.js'
import { addBlog, resolveApproval, runBlogCycle } from '../src/orchestrator.js'
import { JsonStore } from '../src/store.js'

async function withStore(work) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-approval-reject-'))
  try {
    const store = await new JsonStore(join(dir, 'state.json')).init()
    return await work(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('rejecting a CREATE Human Gate marks only the approval rejected and performs no remote publish', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Human Gate Journal',
      brain: { purpose: '承認フローを検証する', topics: ['AI初心者'] },
      connector: { type: 'memory' },
      autonomy: { level: 2, allowCreate: true, allowPublish: false },
    })

    const cycle = await runBlogCycle(store, blog.id, { provider: new RuleBasedProvider() })
    assert.equal(cycle.approval.status, 'pending')
    assert.equal(cycle.approval.action, 'PUBLISH')

    const result = await resolveApproval(store, cycle.approval.id, false)
    const state = await store.read()
    const approval = state.approvals.find((item) => item.id === cycle.approval.id)
    const article = state.articles.find((item) => item.id === cycle.article.id)
    const savedBlog = state.blogs.find((item) => item.id === blog.id)

    assert.deepEqual(result, { status: 'rejected' })
    assert.equal(approval.status, 'rejected')
    assert.ok(approval.resolvedAt)
    assert.equal(article.status, 'draft')
    assert.equal(savedBlog.remotePosts.length, 0)
    assert.equal(state.experiments.length, 0)
    assert.equal(state.activities.some((item) => item.type === 'content.published.after-approval'), false)
  })
})
