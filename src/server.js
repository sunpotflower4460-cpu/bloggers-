// @feature F-001
// @feature F-002
// @feature F-004
// @feature F-005
// @feature F-006
// @feature F-007
// @feature F-008
// @feature F-009
// @feature F-010
// @feature F-011
// @feature F-012
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorizeApiAccess, loadAuthConfig, publicAuthSummary } from './auth.js'
import { createOidcManager } from './oidc.js'
import {
  oidcSessionIsActive,
  oidcSessionRegistrySummary,
  registerOidcSession,
  revokeAllOidcSessions,
  revokeOidcSession,
} from './oidc-session-store.js'
import { recordActivity, addBlog, setPaused, summarizeHQ, testConnection, updateBlog } from './orchestrator.js'
import { buildPortfolioPlan } from './portfolio.js'
import { resolveApprovalExclusive, runBlogCycleExclusive, runPortfolioCycleExclusive } from './runtime.js'
import { createScheduler } from './scheduler.js'
import { resolveSecret, secretResolverStatus } from './secrets.js'
import {
  configureAiBudgetVersioned,
  configureSchedulerVersioned,
  settingsVersions,
} from './settings-control.js'
import { createStore, storageMode } from './storage.js'
import { publicSystemView } from './system-store.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const publicDir = resolve(root, 'src/public')
const tokensPath = resolve(root, 'docs/04-design/tokens.css')
const port = Number(process.env.PORT || 3000)
const authConfig = loadAuthConfig()
const oidc = createOidcManager()
const schedulerMode = String(process.env.BLOGGERS_SCHEDULER_MODE || 'embedded').toLowerCase() === 'external' ? 'external' : 'embedded'
const store = await createStore()
const scheduler = createScheduler({
  store,
  runPortfolioCycle: runPortfolioCycleExclusive,
  runBlogCycle: runBlogCycleExclusive,
  recordActivity,
})
if (schedulerMode === 'embedded') scheduler.start()

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  response.end(`${JSON.stringify(payload)}\n`)
}

function sendRedirect(response, location, setCookies = []) {
  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}),
  })
  response.end()
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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

function isLoopback(request) {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function presentedToken(request) {
  const authorization = String(request.headers.authorization || '')
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim()
  return String(request.headers['x-bloggers-token'] || '').trim()
}

function isMutation(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase())
}

async function oidcStatus(cookieHeader) {
  const status = oidc.status(cookieHeader)
  if (!status.authenticated || !status.principal) return { ...status, serverSideRevocation: true }
  const active = await oidcSessionIsActive(store, { cookieHeader, principal: status.principal })
  return {
    ...status,
    authenticated: active,
    principal: active ? status.principal : null,
    serverSideRevocation: true,
  }
}

async function authorizeApi(request, response, url) {
  const token = presentedToken(request)
  let sessionPrincipal = null
  if (!token) {
    const candidate = oidc.sessionPrincipal(request.headers.cookie)
    if (candidate && await oidcSessionIsActive(store, { cookieHeader: request.headers.cookie, principal: candidate })) {
      sessionPrincipal = candidate
    }
  }
  if (sessionPrincipal && isMutation(request.method) && !oidc.trustedMutationOrigin(request.headers.origin)) {
    sendJson(response, 403, { error: 'Session-authenticated mutations require an exact same-origin Origin header.' })
    return null
  }

  const auth = authorizeApiAccess({
    method: request.method,
    pathname: url.pathname,
    token,
    principal: sessionPrincipal,
    loopback: isLoopback(request) && !oidc.enabled,
    config: authConfig,
  })
  if (auth.ok) return auth
  const headers = auth.status === 401 && token ? { 'WWW-Authenticate': 'Bearer realm="Bloggers HQ"' } : {}
  sendJson(response, auth.status || 403, { error: auth.error, requiredRole: auth.requiredRole ?? null }, headers)
  return null
}

function aiSettings() {
  const fallback = process.env.BLOGGERS_AI_MODEL || null
  const models = {
    decide: process.env.BLOGGERS_AI_DECIDE_MODEL || fallback,
    write: process.env.BLOGGERS_AI_WRITE_MODEL || fallback,
    revise: process.env.BLOGGERS_AI_REVISE_MODEL || process.env.BLOGGERS_AI_WRITE_MODEL || fallback,
  }
  const apiKeyReference = process.env.BLOGGERS_AI_API_KEY_REF || 'BLOGGERS_AI_API_KEY'
  const apiKeyConfigured = Boolean(resolveSecret(apiKeyReference, { label: 'AI API key' }))
  const remote = Boolean(process.env.BLOGGERS_AI_BASE_URL && apiKeyConfigured && models.decide && models.write && models.revise)
  return { mode: remote ? 'remote-openai-compatible-routed' : 'local-rule-based', models }
}

async function api(request, response, url, auth) {
  const { pathname } = url

  if (request.method === 'GET' && pathname === '/api/hq') {
    const hq = summarizeHQ(await store.read())
    hq.system = publicSystemView(hq.system)
    return sendJson(response, 200, hq)
  }
  if (request.method === 'GET' && pathname === '/api/portfolio') return sendJson(response, 200, buildPortfolioPlan(await store.read()))

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
  if (request.method === 'POST' && connectionParams) return sendJson(response, 200, await testConnection(store, connectionParams.blogId))

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
    return sendJson(response, 200, {
      analytics: state.analytics.slice(0, 500),
      experiments: state.experiments.slice(0, 300),
      memories: state.memories.filter((item) => item.type === 'experiment-learning').slice(0, 300),
    })
  }

  if (request.method === 'GET' && pathname === '/api/activity') {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)))
    const state = await store.read()
    return sendJson(response, 200, { activities: state.activities.slice(0, limit), workflows: state.workflows.slice(0, limit) })
  }

  if (request.method === 'GET' && pathname === '/api/jobs') {
    const state = await store.read()
    if (auth.role === 'viewer') {
      return sendJson(response, 200, { jobs: [], locks: [], restricted: true })
    }
    return sendJson(response, 200, { jobs: state.jobs.slice(-300).reverse(), locks: state.locks.slice(0, 100), restricted: false })
  }

  if (request.method === 'GET' && pathname === '/api/settings') {
    const state = await store.read()
    const secretStatus = secretResolverStatus()
    return sendJson(response, 200, {
      system: publicSystemView(state.system),
      systemVersions: await settingsVersions(store),
      ai: aiSettings(),
      aiUsage: auth.role === 'viewer' ? [] : state.aiUsage.slice(0, 100),
      runtime: {
        schedulerMode,
        storage: storageMode(),
        storageBackend: store.backend ?? 'unknown',
        managedSecrets: secretStatus.managed,
      },
      security: {
        ...publicAuthSummary(authConfig),
        oidc: await oidcStatus(request.headers.cookie),
        oidcSessions: auth.role === 'admin' ? await oidcSessionRegistrySummary(store) : null,
        currentPrincipal: auth?.principal ? {
          id: auth.principal.id,
          name: auth.principal.name,
          role: auth.principal.role,
          authType: auth.principal.authType ?? 'unknown',
        } : null,
      },
    })
  }

  if (request.method === 'PATCH' && pathname === '/api/settings/scheduler') {
    const body = await readJson(request)
    const expectedVersion = body.expectedVersion ?? null
    delete body.expectedVersion
    const schedulerConfig = await configureSchedulerVersioned(store, body, { expectedVersion })
    await recordActivity(store, {
      agent: 'human-control',
      type: 'scheduler.configured',
      message: schedulerConfig.enabled ? `定時自律運用を${schedulerConfig.intervalMinutes}分間隔で有効化しました。` : '定時自律運用を無効化しました。',
      detail: { ...schedulerConfig, actor: auth?.principal?.id ?? null },
    })
    return sendJson(response, 200, { scheduler: schedulerConfig })
  }

  if (request.method === 'PATCH' && pathname === '/api/settings/ai-budget') {
    const body = await readJson(request)
    const expectedVersion = body.expectedVersion ?? null
    delete body.expectedVersion
    const budget = await configureAiBudgetVersioned(store, body, { expectedVersion })
    await recordActivity(store, { agent: 'human-control', type: 'ai.budget.configured', message: `AI月間予算を$${budget.monthlyUsd}に設定しました。`, detail: { ...budget, actor: auth?.principal?.id ?? null } })
    return sendJson(response, 200, { aiBudget: budget })
  }

  if (request.method === 'POST' && pathname === '/api/settings/sessions/revoke-all') {
    const result = await revokeAllOidcSessions(store, { actor: auth?.principal?.id ?? null })
    await recordActivity(store, {
      agent: 'human-control',
      type: 'oidc.sessions.revoked-all',
      message: `OIDC Sessionを${result.revokedCount}件失効しました。`,
      detail: { ...result, actor: auth?.principal?.id ?? null },
    })
    return sendJson(response, 200, result)
  }

  if (request.method === 'POST' && pathname === '/api/workflows/run') {
    const body = await readJson(request)
    const result = body.blogId
      ? await runBlogCycleExclusive(store, body.blogId, { trigger: 'manual' })
      : await runPortfolioCycleExclusive(store, { trigger: 'manual' })
    return sendJson(response, 200, result)
  }

  if (request.method === 'POST' && pathname === '/api/system/pause') return sendJson(response, 200, await setPaused(store, true))
  if (request.method === 'POST' && pathname === '/api/system/resume') return sendJson(response, 200, await setPaused(store, false))

  const approvalParams = match(pathname, '/api/approvals/:approvalId/resolve')
  if (request.method === 'POST' && approvalParams) {
    const body = await readJson(request)
    return sendJson(response, 200, await resolveApprovalExclusive(store, approvalParams.approvalId, body.approved !== false))
  }

  return sendJson(response, 404, { error: 'API route not found' })
}

async function authRoute(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/auth/status') {
    return sendJson(response, 200, await oidcStatus(request.headers.cookie))
  }

  if (request.method === 'GET' && url.pathname === '/auth/login') {
    const login = await oidc.beginLogin({ returnTo: url.searchParams.get('returnTo') || '/' })
    return sendRedirect(response, login.redirectUrl, login.setCookies)
  }

  if (request.method === 'GET' && url.pathname === '/auth/callback') {
    const completed = await oidc.completeLogin({
      query: Object.fromEntries(url.searchParams.entries()),
      cookieHeader: request.headers.cookie,
    })
    await registerOidcSession(store, {
      cookieHeader: completed.setCookies[0],
      principal: completed.principal,
    })
    return sendRedirect(response, completed.returnTo, completed.setCookies)
  }

  if (request.method === 'POST' && url.pathname === '/auth/logout') {
    if (!oidc.enabled) return sendJson(response, 404, { error: 'OIDC is not configured.' })
    if (!oidc.trustedMutationOrigin(request.headers.origin)) {
      return sendJson(response, 403, { error: 'OIDC logout requires an exact same-origin Origin header.' })
    }
    const principal = oidc.sessionPrincipal(request.headers.cookie)
    const revocation = await revokeOidcSession(store, {
      cookieHeader: request.headers.cookie,
      actor: principal?.id ?? null,
    })
    if (revocation.revoked) {
      await recordActivity(store, {
        agent: 'human-control',
        type: 'oidc.session.revoked',
        message: 'OIDC Sessionをserver-sideで失効してログアウトしました。',
        detail: { actor: principal?.id ?? null },
      })
    }
    return sendJson(response, 200, { ok: true, serverSideRevoked: revocation.revoked }, { 'Set-Cookie': oidc.logoutCookies() })
  }

  return sendJson(response, 404, { error: 'Authentication route not found' })
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)

    if (url.pathname.startsWith('/auth/')) return await authRoute(request, response, url)

    if (url.pathname === '/api/health' && request.method === 'GET') {
      const state = await store.read()
      return sendJson(response, 200, {
        ok: true,
        service: 'bloggers-ai-editorial-os',
        paused: state.system.paused,
        scheduler: state.system.scheduler,
        schedulerMode,
        storageBackend: store.backend ?? 'unknown',
        managedSecrets: secretResolverStatus().managed,
        oidc: oidc.enabled,
        queuedJobs: state.jobs.filter((item) => item.status === 'queued').length,
        activeLocks: state.locks.length,
      })
    }
    if (url.pathname.startsWith('/api/')) {
      const auth = await authorizeApi(request, response, url)
      if (!auth) return
      return await api(request, response, url, auth)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed' })
    if (url.pathname === '/' || url.pathname === '/index.html') return await sendFile(response, resolve(publicDir, 'index.html'), 'text/html; charset=utf-8')
    if (url.pathname === '/app.js') return await sendFile(response, resolve(publicDir, 'app.js'), 'text/javascript; charset=utf-8')
    if (url.pathname === '/styles.css') return await sendFile(response, resolve(publicDir, 'styles.css'), 'text/css; charset=utf-8')
    if (url.pathname === '/tokens.css') return await sendFile(response, tokensPath, 'text/css; charset=utf-8')
    return sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    sendJson(response, error instanceof SyntaxError ? 400 : Number(error.status || 500), { error: error.message, code: error.code ?? null })
  }
})

function shutdown() {
  scheduler.stop()
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(port, () => {
  const security = authConfig.configured || oidc.enabled ? 'authentication enabled' : 'local-only API until auth is configured'
  console.log(`Bloggers HQ running on http://localhost:${port} (${security}; scheduler=${schedulerMode}; storage=${store.backend ?? 'unknown'})`)
})
