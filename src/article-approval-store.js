// @feature F-004
// @feature F-006
// @feature F-012

const ARTICLE_LIMIT = 5000
const APPROVAL_LIMIT = 3000

function bounded(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.round(parsed)))
}

function mergePatch(target, patch = {}) {
  for (const [key, value] of Object.entries(patch)) target[key] = structuredClone(value)
  return target
}

export async function saveArticle(store, article, { limit = ARTICLE_LIMIT } = {}) {
  if (!article?.id) throw new Error('Article id is required')
  if (!article?.blogId) throw new Error('Article blogId is required')
  const keep = bounded(limit, ARTICLE_LIMIT, 50_000)
  if (typeof store.articleUpsert === 'function') return store.articleUpsert(structuredClone(article), { limit: keep })

  let saved = null
  await store.mutate((state) => {
    state.articles ??= []
    const index = state.articles.findIndex((item) => item.id === article.id)
    if (index >= 0) state.articles.splice(index, 1)
    state.articles.unshift(structuredClone(article))
    state.articles = state.articles.slice(0, keep)
    saved = structuredClone(article)
  })
  return saved
}

export async function saveApproval(store, approval, { limit = APPROVAL_LIMIT } = {}) {
  if (!approval?.id) throw new Error('Approval id is required')
  if (!approval?.blogId) throw new Error('Approval blogId is required')
  const keep = bounded(limit, APPROVAL_LIMIT, 30_000)
  if (typeof store.approvalUpsert === 'function') return store.approvalUpsert(structuredClone(approval), { limit: keep })

  let saved = null
  await store.mutate((state) => {
    state.approvals ??= []
    const index = state.approvals.findIndex((item) => item.id === approval.id)
    if (index >= 0) state.approvals.splice(index, 1)
    state.approvals.unshift(structuredClone(approval))
    state.approvals = state.approvals.slice(0, keep)
    saved = structuredClone(approval)
  })
  return saved
}

export async function saveArticleAndApproval(store, article, approval, {
  articleLimit = ARTICLE_LIMIT,
  approvalLimit = APPROVAL_LIMIT,
} = {}) {
  if (!article?.id || !approval?.id) throw new Error('Article and approval ids are required')
  if (typeof store.articleApprovalSave === 'function') {
    return store.articleApprovalSave(structuredClone(article), structuredClone(approval), {
      articleLimit: bounded(articleLimit, ARTICLE_LIMIT, 50_000),
      approvalLimit: bounded(approvalLimit, APPROVAL_LIMIT, 30_000),
    })
  }

  let result
  await store.mutate((state) => {
    state.articles ??= []
    state.approvals ??= []
    const articleIndex = state.articles.findIndex((item) => item.id === article.id)
    if (articleIndex >= 0) state.articles.splice(articleIndex, 1)
    const approvalIndex = state.approvals.findIndex((item) => item.id === approval.id)
    if (approvalIndex >= 0) state.approvals.splice(approvalIndex, 1)
    state.articles.unshift(structuredClone(article))
    state.approvals.unshift(structuredClone(approval))
    state.articles = state.articles.slice(0, bounded(articleLimit, ARTICLE_LIMIT, 50_000))
    state.approvals = state.approvals.slice(0, bounded(approvalLimit, APPROVAL_LIMIT, 30_000))
    result = { article: structuredClone(article), approval: structuredClone(approval) }
  })
  return result
}

export async function resolveApprovalAndArticle(store, {
  approvalId,
  approvalPatch,
  articleId = null,
  articlePatch = null,
} = {}) {
  if (!approvalId) throw new Error('approvalId is required')
  if (typeof store.articleApprovalResolve === 'function') {
    return store.articleApprovalResolve({ approvalId, approvalPatch, articleId, articlePatch })
  }

  let result
  await store.mutate((state) => {
    const approval = (state.approvals ?? []).find((item) => item.id === approvalId)
    if (!approval) throw new Error('Approval not found')
    mergePatch(approval, approvalPatch)
    let article = null
    if (articleId) {
      article = (state.articles ?? []).find((item) => item.id === articleId)
      if (!article) throw new Error('Article not found')
      mergePatch(article, articlePatch ?? {})
    }
    result = {
      approval: structuredClone(approval),
      article: article ? structuredClone(article) : null,
    }
  })
  return result
}
