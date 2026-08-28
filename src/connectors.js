// @feature F-003
import { createId, nowIso } from './store.js'

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
    const post = {
      id: createId('remote'),
      title: article.title,
      content: article.body,
      status: 'draft',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await this.store.mutate((state) => {
      const blog = state.blogs.find((item) => item.id === this.blog.id)
      blog.remotePosts ??= []
      blog.remotePosts.push(post)
    })
    return post
  }

  async updatePost(postId, changes) {
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
    this.username = process.env[config.usernameEnv ?? '']
    this.password = process.env[config.passwordEnv ?? '']
    if (!this.endpoint) throw new Error('WordPress endpoint is required')
  }

  async #request(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers ?? {}) }
    if (this.username && this.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`
    }
    if (options.body) headers['Content-Type'] = 'application/json'

    const response = await fetch(`${this.endpoint}/wp-json/wp/v2${path}`, {
      ...options,
      headers,
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
      throw new Error(message)
    }
    return { payload, response }
  }

  async listPosts(limit = 20) {
    const { payload } = await this.#request(`/posts?per_page=${Math.min(limit, 100)}&context=edit`)
    return payload
  }

  async createDraft(article) {
    const { payload } = await this.#request('/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: article.title,
        content: article.body,
        status: 'draft',
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

export function createConnector({ blog, store }) {
  switch (blog.connector?.type) {
    case 'wordpress':
      return new WordPressConnector({ blog, store })
    case 'memory':
    case undefined:
      return new MemoryConnector({ blog, store })
    default:
      throw new Error(`Unsupported connector: ${blog.connector.type}`)
  }
}

export { BaseConnector, MemoryConnector, WordPressConnector }
