// @feature F-001
// @feature F-002
// @feature F-004
// @feature F-006
// @feature F-007
// @feature F-008
// @feature F-009
// @feature F-012
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonStore } from './store.js'
import {
  addBlog,
  resolveApproval,
  runBlogCycle,
  runPortfolioCycle,
  setPaused,
  summarizeHQ,
  testConnection,
  updateBlog,
} from './orchestrator.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const publicDir = resolve(root, 'src/public')
const tokensPath = resolve(root, 'docs/04-design/tokens.css')
const port = Number(process.env.PORT || 3000)
const store = await new JsonStore().init()

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(`${JSON.stringify(payload)}\n`)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}

async function sendFile(response, path, type) {
  const body = await readFile(path)
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=60',
  })
  response.end(body)
}

function match(pathname, pattern) {
  const names = []
  const source = pattern
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1))
        return '([^/]+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  const found = pathname.match(new RegExp(`^${source}$`))
  if (!found) return null
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1])]))
}

async function api(request, response, url) {
  const { pathname } = url

  if (request.method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, service: 'bloggers-ai-editorial-os' })
  }

  if (request.method === 'GET' && pathname === '/api/hq') {
    return sendJson(response, 200, summarizeHQ(await store.read()))
  }

  if (request.method === 'GET' && pathname === '/api/blogs') {
    const state = await store.read()
    return sendJson(response, 200, { blogs: state.blogs })
  }

  if (request.method === 'POST' && pathname === '/api/blogs') {
    const blog = await addBlog(store, await readJson(request))
    return sendJson(response, 201, { blog })
  }

  const blogParams = match(pathname, '/api/blogs/:blogId')
  if (request.method === 'PATCH' && blogParams) {
    const blog = await updateBlog(store, blogParams.blogId, await readJson(request))
    return sendJson(response, 200, { blog })
  }

  const connectionParams = match(pathname, '/api/blogs/:blogId/test-connection')
  if (request.method === 'POST' && connectionParams) {
    return sendJson(response, 200, await testConnection(store, connectionParams.blogId))
  }

  if (request.method === 'GET' && pathname === '/api/content') {
    const state = await store.read()
    return sendJson(response, 200, {
      ideas: state.ideas.slice(0, 200),
      articles: state.articles.slice(0, 200),
      approvals: state.approvals.slice(0, 200),
    })
  }

  if (request.method === 'GET' && pathname === '/api/analytics') {
    const state = await store.read()
    return sendJson(response, 200, { analytics: state.analytics.slice(0, 500) })
  }

  if (request.method === 'GET' && pathname === '/api/activity') {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)))
    const state = await store.read()
    return sendJson(response, 200, {
      activities: state.activities.slice(0, limit),
      workflows: state.workflows.slice(0, limit),
    })
  }

  if (request.method === 'GET' && pathname === '/api/settings') {
    const state = await store.read()
    return sendJson(response, 200, {
      system: state.system,
      ai: {
        mode: process.env.BLOGGERS_AI_BASE_URL && process.env.BLOGGERS_AI_API_KEY && process.env.BLOGGERS_AI_MODEL
          ? 'remote-openai-compatible'
          : 'local-rule-based',
        model: process.env.BLOGGERS_AI_MODEL || null,
      },
    })
  }

  if (request.method === 'POST' && pathname === '/api/workflows/run') {
    const body = await readJson(request)
    const result = body.blogId ? await runBlogCycle(store, body.blogId) : await runPortfolioCycle(store)
    return sendJson(response, 200, result)
  }

  if (request.method === 'POST' && pathname === '/api/system/pause') {
    return sendJson(response, 200, await setPaused(store, true))
  }

  if (request.method === 'POST' && pathname === '/api/system/resume') {
    return sendJson(response, 200, await setPaused(store, false))
  }

  const approvalParams = match(pathname, '/api/approvals/:approvalId/resolve')
  if (request.method === 'POST' && approvalParams) {
    const body = await readJson(request)
    const result = await resolveApproval(store, approvalParams.approvalId, body.approved !== false)
    return sendJson(response, 200, result)
  }

  return sendJson(response, 404, { error: 'API route not found' })
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) return await api(request, response, url)

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'Method not allowed' })
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return await sendFile(response, resolve(publicDir, 'index.html'), 'text/html; charset=utf-8')
    }
    if (url.pathname === '/app.js') {
      return await sendFile(response, resolve(publicDir, 'app.js'), 'text/javascript; charset=utf-8')
    }
    if (url.pathname === '/styles.css') {
      return await sendFile(response, resolve(publicDir, 'styles.css'), 'text/css; charset=utf-8')
    }
    if (url.pathname === '/tokens.css') {
      return await sendFile(response, tokensPath, 'text/css; charset=utf-8')
    }

    return sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 500
    sendJson(response, status, { error: error.message })
  }
})

server.listen(port, () => {
  console.log(`Bloggers HQ running on http://localhost:${port}`)
})
