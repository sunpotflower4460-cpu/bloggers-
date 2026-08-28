import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnector, createGhostAdminToken, markdownToBasicHtml } from '../src/connectors.js'
import { addBlog } from '../src/orchestrator.js'
import { JsonStore } from '../src/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bloggers-ghost-test-'))
  const store = await new JsonStore(join(dir, 'state.json')).init()
  try {
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function decodePart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

test('Ghost Admin JWT uses key id, five-minute expiry and admin audience', () => {
  const token = createGhostAdminToken('key-id:0123456789abcdef', { now: 1_700_000_000_000 })
  const [headerPart, payloadPart, signature] = token.split('.')
  const header = decodePart(headerPart)
  const payload = decodePart(payloadPart)
  assert.equal(header.alg, 'HS256')
  assert.equal(header.kid, 'key-id')
  assert.equal(payload.aud, '/admin/')
  assert.equal(payload.iat, 1_700_000_000)
  assert.equal(payload.exp - payload.iat, 300)
  assert.ok(signature.length > 20)
})

test('basic Markdown conversion produces well-formed HTML for Ghost source=html', () => {
  const html = markdownToBasicHtml('# Title\n\nHello **world**.\n\n- one\n- two\n\n[Docs](https://example.com)')
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<strong>world<\/strong>/)
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/)
  assert.match(html, /<a href="https:\/\/example.com">Docs<\/a>/)
})

test('Ghost blog registration stores only Admin API key reference', async () => {
  await withStore(async (store) => {
    const blog = await addBlog(store, {
      name: 'Ghost Journal',
      connector: {
        type: 'ghost',
        endpoint: 'https://journal.example.com',
        adminKeyEnv: 'GHOST_JOURNAL_ADMIN_KEY',
        apiVersion: 'v6.0',
      },
    })
    assert.equal(blog.connector.type, 'ghost')
    assert.equal(blog.connector.adminKeyEnv, 'GHOST_JOURNAL_ADMIN_KEY')
    assert.equal(blog.connector.apiVersion, 'v6.0')
    const state = await store.read()
    assert.equal(state.blogs[0].connector.adminKeyEnv, 'GHOST_JOURNAL_ADMIN_KEY')
  })
})

test('Ghost connector creates HTML drafts and uses latest updated_at before edits', async () => {
  await withStore(async (store) => {
    const previousKey = process.env.GHOST_TEST_ADMIN_KEY
    process.env.GHOST_TEST_ADMIN_KEY = 'key-id:0123456789abcdef'
    const originalFetch = globalThis.fetch
    const calls = []

    globalThis.fetch = async (url, options = {}) => {
      const request = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers }
      calls.push(request)
      assert.match(String(options.headers?.Authorization || ''), /^Ghost [^.]+\.[^.]+\.[^.]+$/)
      assert.equal(options.headers?.['Accept-Version'], 'v6.0')

      if (request.method === 'POST' && request.url.includes('/posts/?source=html')) {
        return new Response(JSON.stringify({ posts: [{ id: 'post-1', updated_at: '2026-08-28T00:00:00.000Z', status: 'draft' }] }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'GET' && request.url.includes('/posts/post-1/')) {
        return new Response(JSON.stringify({ posts: [{ id: 'post-1', title: 'Old', html: '<p>Old</p>', updated_at: '2026-08-28T00:00:00.000Z', status: 'draft' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'PUT' && request.url.includes('/posts/post-1/')) {
        return new Response(JSON.stringify({ posts: [{ id: 'post-1', updated_at: '2026-08-28T00:01:00.000Z', status: request.body.posts[0].status || 'draft' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ posts: [], meta: { pagination: { total: 0 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const blog = await addBlog(store, {
        name: 'Ghost Test',
        connector: { type: 'ghost', endpoint: 'https://ghost.example.com', adminKeyEnv: 'GHOST_TEST_ADMIN_KEY', apiVersion: 'v6.0' },
      })
      const connector = createConnector({ blog, store })
      const draft = await connector.createDraft({ id: 'article-1', title: 'Draft', body: '# Draft\n\nHello.' })
      assert.equal(draft.id, 'post-1')
      const createCall = calls.find((item) => item.method === 'POST')
      assert.match(createCall.body.posts[0].html, /<h1>Draft<\/h1>/)
      assert.equal(createCall.body.posts[0].status, 'draft')

      await connector.updatePost('post-1', { title: 'New title', content: 'Updated **body**.' })
      const updateCall = calls.find((item) => item.method === 'PUT')
      assert.equal(updateCall.body.posts[0].updated_at, '2026-08-28T00:00:00.000Z')
      assert.match(updateCall.body.posts[0].html, /<strong>body<\/strong>/)
      assert.match(updateCall.url, /source=html/)

      await connector.publishPost('post-1')
      const publishCall = calls.filter((item) => item.method === 'PUT').at(-1)
      assert.equal(publishCall.body.posts[0].status, 'published')
      assert.equal(publishCall.body.posts[0].updated_at, '2026-08-28T00:00:00.000Z')
    } finally {
      globalThis.fetch = originalFetch
      if (previousKey === undefined) delete process.env.GHOST_TEST_ADMIN_KEY
      else process.env.GHOST_TEST_ADMIN_KEY = previousKey
    }
  })
})
