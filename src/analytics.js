// @feature F-007
import { resolveGoogleAccessToken } from './oauth.js'

function dateDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10)
}

function accessToken(envName) {
  if (!envName) return null
  return String(process.env[envName] || '').trim() || null
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload?.error?.message
      ? payload.error.message
      : `Analytics HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

function googleAuthFor(source = {}, shared = {}) {
  return {
    accessTokenEnv: source.accessTokenEnv || shared.accessTokenEnv,
    refreshTokenEnv: shared.refreshTokenEnv,
    clientIdEnv: shared.clientIdEnv,
    clientSecretEnv: shared.clientSecretEnv,
  }
}

async function searchConsoleMetrics(config, sharedAuth) {
  if (!config?.siteUrl) return null
  const token = await resolveGoogleAccessToken(googleAuthFor(config, sharedAuth))

  const endDate = dateDaysAgo(1)
  const startDate = dateDaysAgo(Math.max(2, Number(config.lookbackDays || 28)))
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(config.siteUrl)}/searchAnalytics/query`
  const payload = await fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, rowLimit: 1 }),
  })
  const row = payload?.rows?.[0] ?? {}
  return {
    source: 'search-console',
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    ctr: Number(row.ctr ?? 0),
    position: Number(row.position ?? 0),
    startDate,
    endDate,
  }
}

async function ga4Metrics(config, sharedAuth) {
  if (!config?.propertyId) return null
  const token = await resolveGoogleAccessToken(googleAuthFor(config, sharedAuth))

  const propertyId = String(config.propertyId).replace(/^properties\//, '')
  const payload = await fetchJson(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${Math.max(2, Number(config.lookbackDays || 28))}daysAgo`, endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
      limit: 1,
    }),
  })

  const names = (payload?.metricHeaders ?? []).map((item) => item.name)
  const values = payload?.rows?.[0]?.metricValues ?? []
  const metrics = Object.fromEntries(names.map((name, index) => [name, Number(values[index]?.value ?? 0)]))
  return {
    source: 'ga4',
    sessions: Number(metrics.sessions ?? 0),
    users: Number(metrics.totalUsers ?? 0),
    views: Number(metrics.screenPageViews ?? 0),
  }
}

async function httpMetrics(config) {
  if (!config?.endpoint) return null
  const token = accessToken(config.bearerTokenEnv)
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const payload = await fetchJson(config.endpoint, { headers })
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Custom analytics endpoint must return a JSON object')
  const numeric = {}
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value
  }
  return { source: 'custom-http', ...numeric }
}

function mergeNumeric(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (key === 'source') continue
    if (typeof value === 'number' && Number.isFinite(value)) target[key] = value
  }
}

export async function collectAnalytics(blog, baseMetrics = {}) {
  const merged = { ...baseMetrics }
  const sources = [{ source: baseMetrics.source || blog.connector?.type || 'cms', ...baseMetrics }]
  const warnings = []
  const sharedAuth = blog.analytics?.googleAuth ?? {}
  const collectors = [
    ['search-console', () => searchConsoleMetrics(blog.analytics?.searchConsole, sharedAuth)],
    ['ga4', () => ga4Metrics(blog.analytics?.ga4, sharedAuth)],
    ['custom-http', () => httpMetrics(blog.analytics?.http)],
  ]

  for (const [name, collect] of collectors) {
    try {
      const metrics = await collect()
      if (!metrics) continue
      sources.push(metrics)
      mergeNumeric(merged, metrics)
    } catch (error) {
      warnings.push({ source: name, error: error.message })
    }
  }

  return {
    ...merged,
    source: sources.map((item) => item.source).filter(Boolean).join('+'),
    sources,
    warnings,
  }
}
