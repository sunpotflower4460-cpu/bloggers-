import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryConnector, WordPressConnector } from '../src/connectors.js'
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

test('WordPressConnector reuses an existing draft with the deterministic article slug', async () => {
  const beforeUser = process.env.WP_IDEMPOTENT_USER
  const beforePassword = process.env.WP_IDEMPOTENT_PASSWORD
  process.env.WP_IDEMPOTENT_USER = 'editor'
  process.env.WP_IDEMPOTENT_PASSWORD = 'app-password'
  const originalFetch = globalThis.fetch
  let postCalls = 0
  const urls = []

  globalThis.fetch = async (url, options = {}) => {
    urls.push(String(url))
    const method = String(options.method || 'GET').toUpperCase()
    if (method === 'POST') postCalls += 1
    if (method === 'GET' && String(url).includes('slug=bloggers-article-stable-id')) {
      return new Response(JSON.stringify([{ id: 77, slug: 'bloggers-article-stable-id', status: 'draft' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  }

  try {
    const connector = new WordPressConnector({
      blog: {
        id: 'wp-blog',
        connector: {
          type: 'wordpress',
          endpoint: 'https://wp.example.com',
          usernameEnv: 'WP_IDEMPOTENT_USER',
          passwordEnv: 'WP_IDEMPOTENT_PASSWORD',
        },
      },
      store: null,
    })
    const draft = await connector.createDraft({ id: 'article-stable-id', title: 'Retry safe', body: 'body' })
    assert.equal(draft.id, 77)
    assert.equal(postCalls, 0)
    assert.ok(urls.some((url) => url.includes('context=edit') && url.includes('per_page=1')))
  } finally {
    globalThis.fetch = originalFetch
    if (beforeUser === undefined) delete process.env.WP_IDEMPOTENT_USER
    else process.env.WP_IDEMPOTENT_USER = beforeUser
    if (beforePassword === undefined) delete process.env.WP_IDEMPOTENT_PASSWORD
    else process.env.WP_IDEMPOTENT_PASSWORD = beforePassword
  }
})
