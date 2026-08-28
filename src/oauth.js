// @feature F-007
// @feature F-012

const googleTokenCache = new Map()

function envValue(name) {
  if (!name) return null
  return String(process.env[name] || '').trim() || null
}

function normalizedAuth(auth = {}) {
  return {
    accessTokenEnv: auth.accessTokenEnv || null,
    refreshTokenEnv: auth.refreshTokenEnv || 'GOOGLE_REFRESH_TOKEN',
    clientIdEnv: auth.clientIdEnv || 'GOOGLE_CLIENT_ID',
    clientSecretEnv: auth.clientSecretEnv || 'GOOGLE_CLIENT_SECRET',
  }
}

function cacheKey(auth) {
  return [auth.clientIdEnv, auth.clientSecretEnv, auth.refreshTokenEnv].filter(Boolean).join('|')
}

export async function resolveGoogleAccessToken(input = {}, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const auth = normalizedAuth(input)
  const direct = envValue(auth.accessTokenEnv)
  const refreshToken = envValue(auth.refreshTokenEnv)
  const clientId = envValue(auth.clientIdEnv)
  const clientSecret = envValue(auth.clientSecretEnv)

  if (!refreshToken || !clientId) {
    if (direct) return { accessToken: direct, source: 'access-token-env', expiresAt: null }
    const missing = []
    if (!refreshToken) missing.push(auth.refreshTokenEnv)
    if (!clientId) missing.push(auth.clientIdEnv)
    throw new Error(`Google OAuth credential env is missing: ${missing.join(', ')}`)
  }

  const key = cacheKey(auth)
  const cached = googleTokenCache.get(key)
  if (cached && cached.expiresAt > now() + 60_000) {
    return { accessToken: cached.accessToken, source: 'refreshed-cache', expiresAt: cached.expiresAt }
  }

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
  if (clientSecret) body.set('client_secret', clientSecret)

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  })
  const payload = await response.json()
  if (!response.ok || !payload?.access_token) {
    const message = payload?.error_description || payload?.error || `Google OAuth HTTP ${response.status}`
    throw new Error(message)
  }

  const expiresIn = Math.max(60, Number(payload.expires_in || 3600))
  const token = { accessToken: payload.access_token, expiresAt: now() + expiresIn * 1000 }
  googleTokenCache.set(key, token)
  return { ...token, source: 'refresh-token' }
}

export function clearGoogleTokenCache() {
  googleTokenCache.clear()
}
