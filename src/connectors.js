// @feature F-003
import { createHmac } from 'node:crypto'
import { beforeExternalWrite } from './execution-context.js'
import { resolveSecret } from './secrets.js'
import { createId, nowIso } from './store.js'

function timeoutMs(name, fallback) {
  const value = Number(process.env[name] || fallback)
  return Math.max(1000, Math.min(300_000, Number.isFinite(value) ? value : fallback))
}

function articleDraftSlug(article) {
  return `bloggers-${String(article?.id || 'article').replace(/[^a-zA-Z0-9-]+/g, '-')}`
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 180)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function markdownToBasicHtml(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const html = []
  let list = []

  function flushList() {
    if (list.length === 0) return
    html.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`)
    list = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushList()
      continue
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/)
    if (bullet) {
      list.push(bullet[1])
      continue
    }
    flushList()
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
    } else {
      html.push(`<p>${inlineMarkdown(line)}</p>`)
    }
  }
  flushList()
  return html.join('\n')
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function createGhostAdminToken(adminKey, { now = Date.now() } = {}) {
  const [id, secretHex, ...rest] = String(adminKey || '').split(':')
  if (!id || !secretHex || rest.length > 0 || !/^[0-9a-f]+$/i.test(secretHex) || secretHex.length % 2 !== 0) {
    throw new Error('Ghost Admin API key must use the id:hex_secret format')
  }
  const issuedAt = Math.floor(now / 1000)
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT', kid: id })
  const payload = base64UrlJson({ iat: issuedAt, exp: issuedAt + 300, aud: '/admin/' })
  const unsigned = `${header}.${payload}`
  const signature = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

class BaseConnector {
  constructor({ blog, store }) {
    this.blog = blog
    this.store = store
  }

  async listPosts() {
    throw new Error('listPosts() is not implemented')
  }

  async createDraft() {
    throw new Error('createDraft() is not implemented')
  }

  async updatePost() {
    throw new Error('updatePost() is not implemented')
  }

  async publishPost() {
    throw new Error('publishPost() is not implemented')
  }

  async getMetrics() {
    return { posts: 0, views: null, note: 'Analytics connector not configured' }
  }
}

class MemoryConnector extends BaseConnector {
  async listPosts() {
    const state = await this.store.read()
    const current = state.blogs.find((item) => item.id === this.blog.id)
    return current?.remotePosts ?? []
  }

  async createDraft(article) {
    await beforeExternalWrite({ connector: 'memory', operation: 'create-draft', blogId: this.blog.id, articleId: article.id })
    return this.store.mutate((state) => {
      const blog = state.blogs.find((item) => item.id === this.blog.id)
      if (!blog) throw new Error('Blog not found')
      blog.remotePosts ??= []
      const existing = blog.remotePosts.find((item) => item.sourceArticleId === article.id)
      if (existing) return structuredClone(existing)

      const post = {
        id: createId('remote'),
        sourceArticleId: article.id,
        title: article.title,
        content: article.body,
        status: 'draft',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      blog.remotePosts.push(post)
      return structuredClone(post)
    })
  }

  async updatePost(postId, changes) {
    await beforeExternalWrite({ connector: 'memory', operation: 'update-post', blogId: this.blog.id, postId })
    return this.store.mutate((state) => {
      const blog = state.blogs.find((item) => item.id === this.blog.id)
      const post = blog?.remotePosts?.find((item) => item.id === postId)
      if (!post) throw new Error('Remote post not found')
      Object.assign(post, changes, { updatedAt: nowIso() })
      return structuredClone(post)
    })
  }

  async publishPost(postId) {
    return this.updatePost(postId, { status: 'publish', publishedAt: nowIso() })
  }

  async getMetrics() {
    const posts = await this.listPosts()
    return {
      posts: posts.length,
      published: posts.filter((item) => item.status === 'publish').length,
      drafts: posts.filter((item) => item.status === 'draft').length,
      views: null,
      source: 'memory',
    }
  }
}

class WordPressConnector extends BaseConnector {
  constructor(options) {
    super(options)
    const config = this.blog.connector ?? {}
    this.endpoint = String(config.endpoint ?? '').replace(/\/$/, '')
    this.username = resolveSecret(config.usernameEnv, { label: 'WordPress username' })
    this.password = resolveSecret(config.passwordEnv, { label: 'WordPress Application Password' })
    if (!this.endpoint) throw new Error('WordPress endpoint is required')
  }

  async #request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase()
    if (!['GET', 'HEAD'].includes(method)) {
      await beforeExternalWrite({ connector: 'wordpress', operation: 'http-write', method, path, blogId: this.blog.id })
    }
    const headers = { Accept: 'application/json', ...(options.headers ?? {}) }
    if (this.username && this.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`
    }
    if (options.body) headers['Content-Type'] = 'application/json'

    const response = await fetch(`${this.endpoint}/wp-json/wp/v2${path}`, {
      ...options,
      headers,
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(timeoutMs('BLOGGERS_CMS_TIMEOUT_MS', 15_000)),
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
    if (!response.ok) {
      const message = typeof payload === 'object' && payload?.message ? payload.message : `WordPress HTTP ${response.status}`
      const error = new Error(message)
      error.status = response.status
      throw error
    }
    return { payload, response }
  }

  async listPosts(limit = 20) {
    const { payload } = await this.#request(`/posts?per_page=${Math.min(limit, 100)}&context=edit`)
    return payload
  }

  async createDraft(article) {
    const slug = articleDraftSlug(article)
    const statuses = 'publish,future,draft,pending,private'
    const { payload: existing } = await this.#request(`/posts?slug=${encodeURIComponent(slug)}&status=${encodeURIComponent(statuses)}&context=edit&per_page=1`)
    if (Array.isArray(existing) && existing[0]) return existing[0]

    const { payload } = await this.#request('/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: article.title,
        content: article.body,
        status: 'draft',
        slug,
      }),
    })
    return payload
  }

  async updatePost(postId, changes) {
    const { payload } = await this.#request(`/posts/${postId}`, {
      method: 'POST',
      body: JSON.stringify(changes),
    })
    return payload
  }

  async publishPost(postId) {
    return this.updatePost(postId, { status: 'publish' })
  }

  async getMetrics() {
    const { payload, response } = await this.#request('/posts?per_page=1&context=edit')
    return {
      posts: Number(response.headers.get('x-wp-total') ?? payload?.length ?? 0),
      views: null,
      source: 'wordpress',
      note: 'Connect Search Console / Analytics for traffic metrics',
    }
  }
}

class GhostConnector extends BaseConnector {
  constructor(options) {
    super(options)
    const config = this.blog.connector ?? {}
    this.endpoint = String(config.endpoint ?? '').replace(/\/$/, '')
    this.adminKey = resolveSecret(config.adminKeyEnv, { required: true, label: 'Ghost Admin API key' })
    this.apiVersion = /^v\d+\.\d+$/.test(String(config.apiVersion || '')) ? String(config.apiVersion) : 'v6.0'
    if (!this.endpoint) throw new Error('Ghost admin endpoint is required')
  }

  async #request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase()
    if (!['GET', 'HEAD'].includes(method)) {
      await beforeExternalWrite({ connector: 'ghost', operation: 'http-write', method, path, blogId: this.blog.id })
    }
    const token = createGhostAdminToken(this.adminKey)
    const headers = {
      Accept: 'application/json',
      'Accept-Version': this.apiVersion,
      Authorization: `Ghost ${token}`,
      ...(options.headers ?? {}),
    }
    if (options.body) headers['Content-Type'] = 'application/json'
    const response = await fetch(`${this.endpoint}/ghost/api/admin${path}`, {
      ...options,
      headers,
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(timeoutMs('BLOGGERS_CMS_TIMEOUT_MS', 15_000)),
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
    if (!response.ok) {
      const message = payload?.errors?.[0]?.message || `Ghost HTTP ${response.status}`
      const error = new Error(message)
      error.status = response.status
      throw error
    }
    return payload
  }

  async listPosts(limit = 20) {
    const payload = await this.#request(`/posts/?limit=${Math.min(limit, 100)}&formats=html`)
    return payload?.posts ?? []
  }

  async #readPost(postId) {
    const payload = await this.#request(`/posts/${encodeURIComponent(postId)}/?formats=html`)
    const post = payload?.posts?.[0]
    if (!post) throw new Error('Ghost post not found')
    return post
  }

  async #findPostBySlug(slug) {
    try {
      const payload = await this.#request(`/posts/slug/${encodeURIComponent(slug)}/?formats=html`)
      return payload?.posts?.[0] ?? null
    } catch (error) {
      if (error?.status === 404) return null
      throw error
    }
  }

  async createDraft(article) {
    const slug = articleDraftSlug(article)
    const existing = await this.#findPostBySlug(slug)
    if (existing) return existing

    const payload = await this.#request('/posts/?source=html', {
      method: 'POST',
      body: JSON.stringify({
        posts: [{
          title: article.title,
          slug,
          html: markdownToBasicHtml(article.body),
          status: 'draft',
        }],
      }),
    })
    const post = payload?.posts?.[0]
    if (!post) throw new Error('Ghost did not return the created post')
    return post
  }

  async updatePost(postId, changes) {
    const current = await this.#readPost(postId)
    const update = { updated_at: current.updated_at }
    if (changes.title !== undefined) update.title = changes.title
    if (changes.content !== undefined) update.html = markdownToBasicHtml(changes.content)
    if (changes.status !== undefined) update.status = changes.status === 'publish' ? 'published' : changes.status

    const query = changes.content !== undefined ? '?source=html&save_revision=true' : '?save_revision=true'
    const payload = await this.#request(`/posts/${encodeURIComponent(postId)}/${query}`, {
      method: 'PUT',
      body: JSON.stringify({ posts: [update] }),
    })
    const post = payload?.posts?.[0]
    if (!post) throw new Error('Ghost did not return the updated post')
    return post
  }

  async publishPost(postId) {
    return this.updatePost(postId, { status: 'published' })
  }

  async getMetrics() {
    const payload = await this.#request('/posts/?limit=1')
    return {
      posts: Number(payload?.meta?.pagination?.total ?? payload?.posts?.length ?? 0),
      views: null,
      source: 'ghost',
      note: 'Connect Search Console / Analytics for traffic metrics',
    }
  }
}

export function createConnector({ blog, store }) {
  switch (blog.connector?.type) {
    case 'wordpress':
      return new WordPressConnector({ blog, store })
    case 'ghost':
      return new GhostConnector({ blog, store })
    case 'memory':
    case undefined:
      return new MemoryConnector({ blog, store })
    default:
      throw new Error(`Unsupported connector: ${blog.connector.type}`)
  }
}

export { BaseConnector, GhostConnector, MemoryConnector, WordPressConnector }
