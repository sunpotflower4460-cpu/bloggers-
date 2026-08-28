import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryConnector } from '../src/connectors.js'
import { addBlog } from '../src/orchestrator.js'
import { JsonStore } from '../src/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-connectors-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('MemoryConnector reuses the same remote draft for the same local article', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, { name: 'Connector Blog', connector: { type: 'memory' } })
    const connector = new MemoryConnector({ blog, store })
    const article = { id: 'article-stable-id', title: 'Idempotency', body: 'body' }

    const first = await connector.createDraft(article)
    const second = await connector.createDraft(article)
    const posts = await connector.listPosts()

    assert.equal(first.id, second.id)
    assert.equal(posts.length, 1)
    assert.equal(posts[0].sourceArticleId, article.id)
  })
})
