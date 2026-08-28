import test from 'node:test'
import assert from 'node:assert/strict'
import { clearGoogleTokenCache, resolveGoogleAccessToken } from '../src/oauth.js'

function saveEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]))
}

function restoreEnv(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

test('Google OAuth refreshes once and keeps the access token in memory cache only', async () => {
  const names = ['GOOGLE_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GSC_ACCESS_TOKEN']
  const before = saveEnv(names)
  clearGoogleTokenCache()
  process.env.GOOGLE_REFRESH_TOKEN = 'refresh-secret'
  process.env.GOOGLE_CLIENT_ID = 'client-id'
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret'
  delete process.env.GSC_ACCESS_TOKEN

  let calls = 0
  let requestBody = ''
  const fetchImpl = async (url, options) => {
    calls += 1
    assert.equal(url, 'https://oauth2.googleapis.com/token')
    requestBody = String(options.body)
    return new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const now = Date.parse('2026-08-28T04:00:00.000Z')
    const first = await resolveGoogleAccessToken({ accessTokenEnv: 'GSC_ACCESS_TOKEN' }, { fetchImpl, now: () => now })
    const second = await resolveGoogleAccessToken({ accessTokenEnv: 'GSC_ACCESS_TOKEN' }, { fetchImpl, now: () => now + 1000 })

    assert.equal(first.accessToken, 'fresh-access')
    assert.equal(first.source, 'refresh-token')
    assert.equal(second.accessToken, 'fresh-access')
    assert.equal(second.source, 'refreshed-cache')
    assert.equal(calls, 1)
    assert.match(requestBody, /grant_type=refresh_token/)
    assert.match(requestBody, /refresh_token=refresh-secret/)
    assert.match(requestBody, /client_id=client-id/)
  } finally {
    clearGoogleTokenCache()
    restoreEnv(before)
  }
})

test('Google OAuth falls back to an already-issued source access token', async () => {
  const names = ['GOOGLE_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GA4_ACCESS_TOKEN']
  const before = saveEnv(names)
  clearGoogleTokenCache()
  delete process.env.GOOGLE_REFRESH_TOKEN
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  process.env.GA4_ACCESS_TOKEN = 'direct-access'

  try {
    const result = await resolveGoogleAccessToken({ accessTokenEnv: 'GA4_ACCESS_TOKEN' }, {
      fetchImpl: async () => { throw new Error('refresh endpoint must not be called') },
    })
    assert.equal(result.accessToken, 'direct-access')
    assert.equal(result.source, 'access-token-env')
  } finally {
    clearGoogleTokenCache()
    restoreEnv(before)
  }
})
