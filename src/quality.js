// @feature F-004
// @feature F-005
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_SOURCE_BYTES = 220_000
const MAX_EXCERPT_CHARS = 5_000

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
  const [a, b] = parts
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase()
  return lower === '::1'
    || lower === '::'
    || lower.startsWith('fc')
    || lower.startsWith('fd')
    || lower.startsWith('fe8')
    || lower.startsWith('fe9')
    || lower.startsWith('fea')
    || lower.startsWith('feb')
}

function privateAddress(ip) {
  const family = isIP(ip)
  if (family === 4) return isPrivateIpv4(ip)
  if (family === 6) return isPrivateIpv6(ip)
  return true
}

export async function assertPublicHttpUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Research source must use http or https')
  if (url.username || url.password) throw new Error('Research source URL must not contain credentials')
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('Local research source is not allowed')

  if (isIP(hostname)) {
    if (privateAddress(hostname)) throw new Error('Private-network research source is not allowed')
  } else {
    const addresses = await lookup(hostname, { all: true, verbatim: true })
    if (addresses.length === 0 || addresses.some((item) => privateAddress(item.address))) {
      throw new Error('Research source resolved to a private or unavailable address')
    }
  }
  return url
}

async function readLimitedBody(response) {
  const announced = Number(response.headers.get('content-length') || 0)
  if (announced > MAX_SOURCE_BYTES) throw new Error('Research source is too large')
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel()
      throw new Error('Research source exceeded the size limit')
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

function htmlToText(html) {
  return cleanText(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"))
}

async function fetchSource(entry, index, fetchImpl = fetch) {
  const url = await assertPublicHttpUrl(entry.url)
  const response = await fetchImpl(url, {
    headers: { Accept: 'text/html, text/plain, application/json;q=0.8' },
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`Research HTTP ${response.status}`)
  const contentType = String(response.headers.get('content-type') || '')
  const body = await readLimitedBody(response)
  const text = /html/i.test(contentType) ? htmlToText(body) : cleanText(body)
  if (!text) throw new Error('Research source returned no readable text')
  return {
    id: `S${index + 1}`,
    label: cleanText(entry.label) || url.hostname,
    url: url.toString(),
    excerpt: text.slice(0, MAX_EXCERPT_CHARS),
  }
}

export async function gatherResearchSources(blog, { fetchImpl = fetch } = {}) {
  const configured = Array.isArray(blog.research?.sources) ? blog.research.sources.slice(0, 6) : []
  const sources = []
  const warnings = []
  for (let index = 0; index < configured.length; index += 1) {
    const entry = configured[index]
    if (!entry?.url) continue
    try {
      sources.push(await fetchSource(entry, index, fetchImpl))
    } catch (error) {
      warnings.push({ url: entry.url, error: error.message })
    }
  }
  return { sources, warnings }
}

function normalizeTitle(post) {
  if (typeof post?.title === 'object') return cleanText(post.title?.rendered)
  return cleanText(post?.title)
}

function normalizeContent(post) {
  if (typeof post?.content === 'object') return cleanText(post.content?.rendered)
  return cleanText(post?.content)
}

export function buildInternalLinkCandidates(posts, decision, limit = 5) {
  const words = cleanText(`${decision?.topic || ''} ${decision?.title || ''}`)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)
  const updateTarget = decision?.action === 'UPDATE' ? String(decision.targetPostId ?? '') : null

  return posts
    .filter((post) => !updateTarget || String(post.id) !== updateTarget)
    .map((post) => {
      const title = normalizeTitle(post)
      const haystack = `${title} ${normalizeContent(post)}`.toLowerCase()
      const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0)
      const url = cleanText(post.link || post.url)
      return { id: post.id, title, url, score }
    })
    .filter((item) => item.title && item.url && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function citedIds(body) {
  return new Set(Array.from(String(body || '').matchAll(/\[(S\d+)\]/g), (match) => match[1]))
}

function claimSegments(body) {
  const segments = []
  for (const paragraph of String(body || '').split(/(?:\r?\n)+/)) {
    const cleaned = cleanText(paragraph.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, ''))
    if (!cleaned || /^https?:\/\//i.test(cleaned)) continue

    // Keep citations written immediately after Japanese/English sentence punctuation
    // attached to the sentence they support: `主張です。[S1]` is one claim, not two.
    const sentences = cleaned.match(/[^。！？!?]+(?:[。！？!?]+|$)(?:\s*\[S\d+\])*/gu) ?? [cleaned]
    for (const sentence of sentences) {
      const text = cleanText(sentence)
      if (text) segments.push(text)
    }
  }
  return segments
}

function claimNumbers(text) {
  return [...String(text || '').matchAll(/(?<![A-Za-z])\d+(?:[.,]\d+)?(?:%|％|円|ドル|人|件|倍|年|月|日|GB|MB|TB)?/gu)]
    .map((match) => match[0].replaceAll(',', '').replace('％', '%'))
}

function citationIdsIn(text) {
  return Array.from(String(text || '').matchAll(/\[(S\d+)\]/g), (match) => match[1])
}

function normalizedEvidence(text) {
  return cleanText(text).replaceAll(',', '').replaceAll('％', '%').toLowerCase()
}

export function evaluateClaimSupport(body, sources = [], { requireCitations = false } = {}) {
  const byId = new Map(sources.map((source) => [source.id, source]))
  const claims = []

  for (const text of claimSegments(body)) {
    const numbers = claimNumbers(text)
    if (numbers.length === 0) continue

    const citationIds = citationIdsIn(text)
    const validCitationIds = citationIds.filter((id) => byId.has(id))
    const evidence = validCitationIds.map((id) => normalizedEvidence(byId.get(id)?.excerpt || '')).join(' ')
    const missingNumbers = numbers.filter((value) => !evidence.includes(value.toLowerCase()))
    const status = validCitationIds.length === 0
      ? 'uncited'
      : missingNumbers.length > 0
        ? 'citation-number-mismatch'
        : 'supported'

    claims.push({
      text,
      numbers,
      citationIds,
      validCitationIds,
      missingNumbers,
      status,
      blocking: requireCitations && status === 'uncited',
    })
  }

  return claims
}

export function evaluateContentQuality({ body, research = {}, sources = [], internalLinks = [] }) {
  const blocking = []
  const warnings = []
  const citations = citedIds(body)
  const validIds = new Set(sources.map((source) => source.id))
  const invalidCitations = [...citations].filter((id) => !validIds.has(id))
  const claimChecks = evaluateClaimSupport(body, sources, { requireCitations: Boolean(research.requireCitations) })
  const uncitedClaims = claimChecks.filter((claim) => claim.status === 'uncited')
  const numberMismatches = claimChecks.filter((claim) => claim.status === 'citation-number-mismatch')

  if (invalidCitations.length > 0) blocking.push(`存在しない出典IDが引用されています: ${invalidCitations.join(', ')}`)
  if (research.requireCitations && sources.length === 0) blocking.push('出典必須ですが、利用可能なResearch Sourceを取得できませんでした。')
  if (research.requireCitations && sources.length > 0 && citations.size === 0) blocking.push('出典必須の記事ですが、本文に[S1]形式の引用がありません。')
  if (research.requireCitations && uncitedClaims.length > 0) blocking.push(`数値・日付を含む検証可能な主張 ${uncitedClaims.length}件に文単位の出典がありません。`)
  if (sources.length > 0 && citations.size === 0) warnings.push('Research Sourceは取得できましたが、本文では引用されていません。')
  if (numberMismatches.length > 0) warnings.push(`引用された出典抜粋で本文中の数値を確認できない主張が ${numberMismatches.length}件あります。人間または強いFact Checkerで再確認してください。`)

  const linked = internalLinks.filter((item) => item.url && String(body || '').includes(item.url))
  if (internalLinks.length > 0 && linked.length === 0) warnings.push('関連する既存記事がありますが、内部リンクが本文にありません。')

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    citations: [...citations],
    citedSources: sources.filter((source) => citations.has(source.id)),
    linkedInternalPosts: linked,
    claimChecks,
  }
}
