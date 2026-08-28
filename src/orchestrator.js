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
import { createAIProvider } from './ai.js'
import { collectAnalytics } from './analytics.js'
import { appendAnalyticsSnapshot } from './analytics-store.js'
import { appendActivity } from './activity-store.js'
import { resolveApprovalAndArticle, saveApproval, saveArticle } from './article-approval-store.js'
import { assertAiBudget, budgetStatus, normalizeAiBudget, recordAiUsage } from './cost.js'
import { createConnector } from './connectors.js'
import { evaluateExperiments, recentLearnings, startExperiment } from './experiments.js'
import { stableId } from './idempotency.js'
import { appendIdea } from './idea-store.js'
import { summarizeJobs } from './jobs.js'
import { buildPortfolioPlan } from './portfolio.js'
import { buildInternalLinkCandidates, evaluateContentQuality, gatherResearchSources } from './quality.js'
import { createId, nowIso } from './store.js'
import { upsertWorkflow } from './workflow-store.js'

const DEFAULT_AUTONOMY = {
  level: 2,
  allowCreate: true,
  allowUpdate: true,
  allowPublish: false,
  allowDelete: false,
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

function cycleId(prefix, key, scope = prefix) {
  return key ? stableId(prefix, `${key}:${scope}`) : createId(prefix)
}

function decisionFromIdea(idea) {
  if (!idea) return null
  return {
    action: idea.action,
    topic: idea.topic ?? '',
    title: idea.title ?? '',
    rationale: idea.rationale ?? '',
    confidence: Number(idea.confidence ?? 0),
    targetPostId: idea.targetPostId ?? null,
  }
}

function sanitizeAnalytics(input = {}) {
  return {
    searchConsole: {
      siteUrl: cleanString(input.searchConsole?.siteUrl),
      accessTokenEnv: cleanString(input.searchConsole?.accessTokenEnv),
      lookbackDays: positiveInteger(input.searchConsole?.lookbackDays, 28),
    },
    ga4: {
      propertyId: cleanString(input.ga4?.propertyId),
      accessTokenEnv: cleanString(input.ga4?.accessTokenEnv),
      lookbackDays: positiveInteger(input.ga4?.lookbackDays, 28),
    },
    http: {
      endpoint: cleanString(input.http?.endpoint),
      bearerTokenEnv: cleanString(input.http?.bearerTokenEnv),
    },
  }
}

function sanitizeResearch(input = {}) {
  const sources = Array.isArray(input.sources)
    ? input.sources
        .map((item) => ({ label: cleanString(item?.label), url: cleanString(item?.url) }))
        .filter((item) => item.url)
        .slice(0, 6)
    : []
  return {
    requireCitations: Boolean(input.requireCitations),
    sources,
  }
}

function sanitizeConnector(input = {}) {
  const type = ['wordpress', 'ghost'].includes(input.type) ? input.type : 'memory'
  if (type === 'wordpress') {
    const connector = {
      type,
      endpoint: cleanString(input.endpoint),
      usernameEnv: cleanString(input.usernameEnv),
      passwordEnv: cleanString(input.passwordEnv),
    }
    if (!connector.endpoint) throw new Error('WordPress endpoint is required')
    return connector
  }
  if (type === 'ghost') {
    const connector = {
      type,
      endpoint: cleanString(input.endpoint),
      adminKeyEnv: cleanString(input.adminKeyEnv),
      apiVersion: /^v\d+\.\d+$/.test(cleanString(input.apiVersion)) ? cleanString(input.apiVersion) : 'v6.0',
    }
    if (!connector.endpoint) throw new Error('Ghost admin endpoint is required')
    if (!connector.adminKeyEnv) throw new Error('Ghost Admin API key environment-variable name is required')
    return connector
  }
  return { type: 'memory' }
}

export function sanitizeBlogInput(input = {}) {
  const name = cleanString(input.name)
  if (!name) throw new Error('Blog name is required')

  const connector = sanitizeConnector(input.connector)
  const level = Math.max(0, Math.min(5, Number(input.autonomy?.level ?? 2)))
  return {
    name,
    slug: String(input.slug || name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, ''),
    active: input.active !== false,
    connector,
    analytics: sanitizeAnalytics(input.analytics),
    research: sanitizeResearch(input.research),
    brain: {
      purpose: cleanString(input.brain?.purpose),
      audience: cleanString(input.brain?.audience),
      voice: cleanString(input.brain?.voice),
      editorialPolicy: cleanString(input.brain?.editorialPolicy),
      monetization: cleanString(input.brain?.monetization),
      topics: Array.isArray(input.brain?.topics)
        ? input.brain.topics.map((item) => cleanString(item)).filter(Boolean).slice(0, 30)
        : [],
    },
    autonomy: {
      ...DEFAULT_AUTONOMY,
      ...(input.autonomy ?? {}),
      level,
      allowDelete: false,
    },
  }
}

export async function addBlog(store, input) {
  const clean = sanitizeBlogInput(input)
  const blog = {
    id: createId('blog'),
    ...clean,
    remotePosts: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  await store.mutate((state) => {
    if (state.blogs.some((item) => item.slug === blog.slug)) throw new Error('A blog with this slug already exists')
    state.blogs.push(blog)
  })
  await recordActivity(store, { blogId: blog.id, agent: 'system', type: 'blog.connected', message: `${blog.name} をBloggers HQへ登録しました。` })
  return blog
}

export async function updateBlog(store, blogId, changes) {
  return store.mutate((state) => {
    const blog = state.blogs.find((item) => item.id === blogId)
    if (!blog) throw new Error('Blog not found')
    if (changes.brain) blog.brain = { ...blog.brain, ...changes.brain }
    if (changes.analytics) blog.analytics = sanitizeAnalytics({ ...blog.analytics, ...changes.analytics })
    if (changes.research) blog.research = sanitizeResearch({ ...blog.research, ...changes.research })
    if (changes.autonomy) {
      const level = Math.max(0, Math.min(5, Number(changes.autonomy.level ?? blog.autonomy.level)))
      blog.autonomy = { ...blog.autonomy, ...changes.autonomy, level, allowDelete: false }
    }
    if (typeof changes.active === 'boolean') blog.active = changes.active
    blog.updatedAt = nowIso()
    return structuredClone(blog)
  })
}

export async function configureAiBudget(store, changes = {}) {
  return store.mutate((state) => {
    state.system.aiBudget = normalizeAiBudget({ ...state.system.aiBudget, ...changes })
    return structuredClone(state.system.aiBudget)
  })
}

export async function recordActivity(store, entry) {
  const activity = {
    id: createId('activity'),
    createdAt: nowIso(),
    blogId: entry.blogId ?? null,
    agent: entry.agent ?? 'system',
    type: entry.type ?? 'info',
    message: entry.message ?? '',
    detail: entry.detail ?? null,
  }
  await appendActivity(store, activity, { limit: 1000 })
  return activity
}

function canExecute(blog, action) {
  const level = Number(blog.autonomy?.level ?? 0)
  if (level <= 0) return false
  if (action === 'CREATE') return Boolean(blog.autonomy?.allowCreate)
  if (action === 'UPDATE') return Boolean(blog.autonomy?.allowUpdate)
  if (action === 'PUBLISH') return level >= 4 && Boolean(blog.autonomy?.allowPublish)
  return false
}

function needsApproval(blog, action) {
  const level = Number(blog.autonomy?.level ?? 0)
  if (action === 'PUBLISH') return level === 3 || !blog.autonomy?.allowPublish
  return level <= 1
}

async function createApproval(store, { id = null, blogId, articleId, action, reason, targetRemoteId = null }) {
  const approvalId = id ?? createId('approval')
  const state = await store.read()
  const existing = state.approvals.find((item) => item.id === approvalId)
  if (existing) return structuredClone(existing)

  const approval = {
    id: approvalId,
    blogId,
    articleId: articleId ?? null,
    targetRemoteId,
    action,
    reason,
    status: 'pending',
    createdAt: nowIso(),
    resolvedAt: null,
  }
  return saveApproval(store, approval, { limit: 3000 })
}

async function startLiveExperiment(store, { blog, article, action, snapshot = null }) {
  const state = await store.read()
  const idea = state.ideas.find((item) => item.id === article.ideaId)
  const baseline = snapshot ?? state.analytics.find((item) => item.blogId === blog.id) ?? null
  if (!baseline) return null
  return startExperiment(store, {
    blog,
    decision: { action, rationale: idea?.rationale || `${action}施策が主要指標を改善するか検証する。` },
    snapshot: baseline,
    ideaId: article.ideaId,
    articleId: article.id,
  })
}

async function callProvider(provider, method, args, store, context) {
  let value
  let error
  try {
    value = await provider[method](args)
  } catch (caught) {
    error = caught
  }
  const usage = typeof provider.drainUsage === 'function' ? provider.drainUsage() : []
  const savedUsage = await recordAiUsage(store, usage, context)
  if (error) throw error
  return {
    value,
    costUsd: savedUsage.reduce((sum, item) => sum + Number(item.estimatedCostUsd || 0), 0),
  }
}

function cycleBudgetExceeded(state, cycleCostUsd) {
  const budget = normalizeAiBudget(state.system.aiBudget)
  return budget.enabled && budget.perCycleUsd > 0 && cycleCostUsd > budget.perCycleUsd
}

async function prepareQualityContext(store, blog, posts, decision) {
  const research = await gatherResearchSources(blog)
  if (research.warnings.length > 0) {
    await recordActivity(store, {
      blogId: blog.id,
      agent: 'researcher',
      type: 'research.partial',
      message: `${research.warnings.length}件のResearch Sourceを取得できませんでした。`,
      detail: research.warnings,
    })
  }
  return {
    sources: research.sources,
    internalLinks: buildInternalLinkCandidates(posts, decision),
  }
}

function articleSourceMetadata(sources) {
  return sources.map((item) => ({ id: item.id, label: item.label, url: item.url }))
}

async function createDraftArticle(store, { id = null, blog, idea, action, draft, remoteId = null, qualityContext }) {
  const articleId = id ?? createId('article')
  const state = await store.read()
  const existing = state.articles.find((item) => item.id === articleId)
  if (existing) return structuredClone(existing)

  const quality = evaluateContentQuality({
    body: draft.body,
    research: blog.research,
    sources: qualityContext.sources,
    internalLinks: qualityContext.internalLinks,
  })
  const article = {
    id: articleId,
    blogId: blog.id,
    ideaId: idea.id,
    action,
    title: draft.title,
    body: draft.body,
    status: action === 'UPDATE' ? 'draft-update' : 'draft',
    provider: draft.provider,
    remoteId,
    quality,
    sources: articleSourceMetadata(qualityContext.sources),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  return saveArticle(store, article, { limit: 5000 })
}

function qualityApprovalReason(article, fallback) {
  if (article.quality?.ok) return fallback
  return `品質ゲートで自動反映を停止しました: ${article.quality.blocking.join(' / ')}`
}

export async function testConnection(store, blogId) {
  const state = await store.read()
  const blog = state.blogs.find((item) => item.id === blogId)
  if (!blog) throw new Error('Blog not found')
  const connector = createConnector({ blog, store })
  const [posts, cmsMetrics] = await Promise.all([connector.listPosts(3), connector.getMetrics()])
  const metrics = await collectAnalytics(blog, cmsMetrics)
  return { ok: true, connector: blog.connector.type, samplePosts: posts.length, metrics }
}

export async function runBlogCycle(store, blogId, options = {}) {
  const startedAt = nowIso()
  const initial = await store.read()
  if (initial.system.paused) return { skipped: true, reason: 'system-paused' }

  const blog = initial.blogs.find((item) => item.id === blogId)
  if (!blog) throw new Error('Blog not found')
  if (!blog.active) return { skipped: true, reason: 'blog-inactive' }

  const cycleKey = cleanString(options.idempotencyKey)
  const workflowId = cycleId('workflow', cycleKey, 'workflow')
  const ideaId = cycleId('idea', cycleKey, 'idea')
  const metricId = cycleId('metric', cycleKey, 'metric')
  const articleId = cycleKey ? cycleId('article', cycleKey, 'article') : null
  const priorWorkflow = cycleKey ? initial.workflows.find((item) => item.id === workflowId) ?? null : null
  let idea = cycleKey ? initial.ideas.find((item) => item.id === ideaId) ?? null : null
  let article = articleId ? initial.articles.find((item) => item.id === articleId) ?? null : null
  let approval = priorWorkflow?.approvalId ? initial.approvals.find((item) => item.id === priorWorkflow.approvalId) ?? null : null
  let experiment = priorWorkflow?.experimentId
    ? initial.experiments.find((item) => item.id === priorWorkflow.experimentId) ?? null
    : article
      ? initial.experiments.find((item) => item.articleId === article.id && item.action === article.action) ?? null
      : null
  let snapshot = cycleKey ? initial.analytics.find((item) => item.id === metricId) ?? null : null
  let decision = priorWorkflow?.decision ?? decisionFromIdea(idea)
  let evaluation = { updated: [], completed: [] }
  let published = article?.status === 'published' && article.remoteId ? { id: article.remoteId } : null

  if (priorWorkflow?.status === 'completed') {
    return {
      workflowId,
      resumed: true,
      decision,
      idea,
      article,
      approval,
      published,
      experiment,
      evaluation,
      metrics: snapshot,
      aiCostUsd: Number(priorWorkflow.aiCostUsd || 0),
      budgetExceeded: false,
    }
  }

  const provider = options.provider ?? createAIProvider()
  if (String(provider.name || '').startsWith('openai-compatible')) assertAiBudget(initial)

  const workflow = {
    ...(priorWorkflow ?? {}),
    id: workflowId,
    blogId,
    trigger: options.trigger || priorWorkflow?.trigger || 'manual',
    idempotencyKey: cycleKey || null,
    attempt: Number(priorWorkflow?.attempt || 0) + 1,
    status: 'running',
    startedAt: priorWorkflow?.startedAt ?? startedAt,
    finishedAt: null,
    decision,
    metricId: snapshot?.id ?? priorWorkflow?.metricId ?? null,
    ideaId: idea?.id ?? priorWorkflow?.ideaId ?? null,
    articleId: article?.id ?? priorWorkflow?.articleId ?? null,
    approvalId: approval?.id ?? priorWorkflow?.approvalId ?? null,
    experimentId: experiment?.id ?? priorWorkflow?.experimentId ?? null,
    publishedRemoteId: article?.remoteId ?? priorWorkflow?.publishedRemoteId ?? null,
    aiCostUsd: Number(priorWorkflow?.aiCostUsd || 0),
    error: null,
  }
  await upsertWorkflow(store, workflow, { limit: 2000 })

  let cycleCostUsd = Number(priorWorkflow?.aiCostUsd || 0)
  try {
    await recordActivity(store, { blogId, agent: 'observer', type: 'cycle.observe', message: `${blog.name} の状態観測を開始しました。`, detail: { trigger: workflow.trigger, idempotencyKey: cycleKey || null, attempt: workflow.attempt } })

    const connector = options.connector ?? createConnector({ blog, store })
    let posts
    let metrics
    if (snapshot) {
      posts = await connector.listPosts(30)
      metrics = snapshot
    } else {
      const observed = await Promise.all([connector.listPosts(30), connector.getMetrics()])
      posts = observed[0]
      const cmsMetrics = observed[1]
      metrics = await collectAnalytics(blog, cmsMetrics)
      snapshot = { id: metricId, blogId, capturedAt: nowIso(), ...metrics }
      await appendAnalyticsSnapshot(store, snapshot, { limit: 5000 })
      workflow.metricId = snapshot.id
      evaluation = await evaluateExperiments(store, blogId, snapshot)
      for (const completed of evaluation.completed) {
        await recordActivity(store, { blogId, agent: 'learner', type: 'experiment.completed', message: `実験結果をBlog Memoryへ保存しました: ${completed.result} / ${completed.targetMetric} ${Number(completed.deltaPct || 0).toFixed(1)}%`, detail: { experimentId: completed.id } })
      }
      if (metrics.warnings?.length) {
        await recordActivity(store, { blogId, agent: 'observer', type: 'analytics.partial', message: `${metrics.warnings.length}個のAnalytics sourceを取得できませんでしたが、利用可能なデータで継続します。`, detail: metrics.warnings })
      }
    }

    const stateWithLearning = await store.read()
    const learnings = recentLearnings(stateWithLearning, blogId)
    const reusableIdea = idea && (idea.action !== 'UPDATE' || idea.targetPostId)
    if (reusableIdea) {
      decision = decisionFromIdea(idea)
      workflow.decision = decision
      await recordActivity(store, { blogId, agent: 'director', type: 'cycle.decide.reused', message: `${decision.action}: ${decision.rationale}`, detail: { ideaId: idea.id, idempotencyKey: cycleKey, learningsUsed: learnings.length } })
    } else {
      const decided = await callProvider(provider, 'decide', { blog, posts, metrics, learnings }, store, { blogId, workflowId: workflow.id })
      cycleCostUsd += decided.costUsd
      decision = decided.value
      workflow.decision = decision
      await recordActivity(store, { blogId, agent: 'director', type: 'cycle.decide', message: `${decision.action}: ${decision.rationale}`, detail: { ...decision, learningsUsed: learnings.length } })

      idea = {
        id: ideaId,
        blogId,
        action: decision.action,
        topic: decision.topic ?? '',
        title: decision.title ?? '',
        rationale: decision.rationale ?? '',
        confidence: Number(decision.confidence ?? 0),
        targetPostId: decision.targetPostId ?? null,
        status: decision.action === 'WAIT' ? 'observing' : 'proposed',
        createdAt: nowIso(),
      }
      await appendIdea(store, idea, { limit: 3000 })
      workflow.ideaId = idea.id
    }

    let qualityContext = { sources: article?.sources ?? [], internalLinks: [] }
    const budgetSnapshot = await store.read()
    const budgetExceeded = cycleBudgetExceeded(budgetSnapshot, cycleCostUsd)
    if (budgetExceeded && decision.action !== 'WAIT') {
      await recordActivity(store, { blogId, agent: 'cost-governor', type: 'ai.budget.cycle-limit', message: `1サイクルのAI予算上限に達したため、追加生成を止めました。 $${cycleCostUsd.toFixed(4)}` })
    } else if (['CREATE', 'UPDATE'].includes(decision.action) && !article) {
      qualityContext = await prepareQualityContext(store, blog, posts, decision)
    }

    if (!budgetExceeded && decision.action === 'CREATE') {
      if (canExecute(blog, 'CREATE') && Number(blog.autonomy.level) >= 2) {
        if (!article) {
          const drafted = await callProvider(provider, 'draft', { blog, decision, learnings, ...qualityContext }, store, { blogId, workflowId: workflow.id })
          cycleCostUsd += drafted.costUsd
          article = await createDraftArticle(store, { id: articleId, blog, idea, action: 'CREATE', draft: drafted.value, qualityContext })
          workflow.articleId = article.id
          await recordActivity(store, { blogId, agent: 'writer', type: 'content.drafted', message: `「${article.title}」の下書きを作成しました。`, detail: { articleId: article.id, provider: article.provider, quality: article.quality } })
        } else {
          await recordActivity(store, { blogId, agent: 'writer', type: 'content.draft-reused', message: `再試行のため既存下書き「${article.title}」を再利用しました。`, detail: { articleId: article.id, idempotencyKey: cycleKey } })
        }

        if (article.status === 'published') {
          published = article.remoteId ? { id: article.remoteId } : null
          if (!experiment) experiment = await startLiveExperiment(store, { blog, article, action: 'CREATE', snapshot })
        } else {
          const canAutoPublish = canExecute(blog, 'PUBLISH') && article.quality.ok
          if (canAutoPublish) {
            const remote = await connector.createDraft(article)
            published = await connector.publishPost(remote.id)
            article = { ...article, status: 'published', remoteId: remote.id, updatedAt: nowIso() }
            await saveArticle(store, article, { limit: 5000 })
            experiment = await startLiveExperiment(store, { blog, article, action: 'CREATE', snapshot })
            await recordActivity(store, { blogId, agent: 'publisher', type: 'content.published', message: `「${article.title}」を自動公開しました。`, detail: { articleId: article.id, remoteId: remote.id, experimentId: experiment?.id ?? null } })
          } else if (needsApproval(blog, 'PUBLISH') || !article.quality.ok) {
            approval = await createApproval(store, {
              id: cycleKey ? cycleId('approval', cycleKey, 'publish') : null,
              blogId,
              articleId: article.id,
              action: 'PUBLISH',
              reason: qualityApprovalReason(article, '現在の自動運用レベルでは公開に人間の承認が必要です。'),
            })
            workflow.approvalId = approval.id
            if (approval.status === 'pending') {
              await recordActivity(store, { blogId, agent: 'editor', type: 'approval.requested', message: `「${article.title}」の公開承認を待っています。`, detail: { approvalId: approval.id, quality: article.quality } })
            }
          }
        }
      } else {
        approval = await createApproval(store, {
          id: cycleKey ? cycleId('approval', cycleKey, 'create') : null,
          blogId,
          action: 'CREATE',
          reason: '現在の自動運用レベルでは下書き作成前に承認が必要です。',
        })
        workflow.approvalId = approval.id
      }
    } else if (!budgetExceeded && decision.action === 'UPDATE') {
      const target = posts.find((post) => String(post.id) === String(decision.targetPostId))
      if (!target) throw new Error('UPDATE target post was not found')

      if (canExecute(blog, 'UPDATE') && Number(blog.autonomy.level) >= 2) {
        if (!article) {
          const revised = await callProvider(provider, 'revise', { blog, decision, post: target, learnings, ...qualityContext }, store, { blogId, workflowId: workflow.id })
          cycleCostUsd += revised.costUsd
          article = await createDraftArticle(store, { id: articleId, blog, idea, action: 'UPDATE', draft: revised.value, remoteId: target.id, qualityContext })
          workflow.articleId = article.id
          await recordActivity(store, { blogId, agent: 'writer', type: 'content.revision-drafted', message: `「${article.title}」の改稿案を作成しました。`, detail: { articleId: article.id, remoteId: target.id, quality: article.quality } })
        } else {
          await recordActivity(store, { blogId, agent: 'writer', type: 'content.revision-reused', message: `再試行のため既存改稿案「${article.title}」を再利用しました。`, detail: { articleId: article.id, idempotencyKey: cycleKey } })
        }

        if (article.status === 'published') {
          published = article.remoteId ? { id: article.remoteId } : { id: target.id }
          if (!experiment) experiment = await startLiveExperiment(store, { blog, article, action: 'UPDATE', snapshot })
        } else {
          const canAutoUpdate = canExecute(blog, 'PUBLISH') && article.quality.ok
          if (canAutoUpdate) {
            published = await connector.updatePost(target.id, { title: article.title, content: article.body })
            article = { ...article, status: 'published', updatedAt: nowIso() }
            await saveArticle(store, article, { limit: 5000 })
            experiment = await startLiveExperiment(store, { blog, article, action: 'UPDATE', snapshot })
            await recordActivity(store, { blogId, agent: 'publisher', type: 'content.updated', message: `「${article.title}」の改稿を自動反映しました。`, detail: { articleId: article.id, remoteId: target.id, experimentId: experiment?.id ?? null } })
          } else {
            approval = await createApproval(store, {
              id: cycleKey ? cycleId('approval', cycleKey, 'update') : null,
              blogId,
              articleId: article.id,
              targetRemoteId: target.id,
              action: 'UPDATE',
              reason: qualityApprovalReason(article, '既存記事の改稿反映には人間の承認が必要です。'),
            })
            workflow.approvalId = approval.id
            if (approval.status === 'pending') {
              await recordActivity(store, { blogId, agent: 'editor', type: 'approval.requested', message: `「${article.title}」の改稿反映を待っています。`, detail: { approvalId: approval.id, remoteId: target.id, quality: article.quality } })
            }
          }
        }
      } else {
        approval = await createApproval(store, {
          id: cycleKey ? cycleId('approval', cycleKey, 'update-before-draft') : null,
          blogId,
          action: 'UPDATE',
          targetRemoteId: target.id,
          reason: '現在の自動運用レベルでは改稿案の作成前に承認が必要です。',
        })
        workflow.approvalId = approval.id
      }
    }

    const finishedAt = nowIso()
    workflow.status = 'completed'
    workflow.finishedAt = finishedAt
    workflow.decision = decision
    workflow.metricId = snapshot?.id ?? workflow.metricId
    workflow.ideaId = idea?.id ?? workflow.ideaId
    workflow.articleId = article?.id ?? workflow.articleId
    workflow.approvalId = approval?.id ?? workflow.approvalId
    workflow.experimentId = experiment?.id ?? workflow.experimentId
    workflow.publishedRemoteId = article?.remoteId ?? published?.id ?? workflow.publishedRemoteId
    workflow.aiCostUsd = cycleCostUsd
    await upsertWorkflow(store, workflow, { limit: 2000 })

    return { workflowId: workflow.id, resumed: Boolean(cycleKey && priorWorkflow), decision, idea, article, approval, published, experiment, evaluation, metrics, aiCostUsd: cycleCostUsd, budgetExceeded }
  } catch (error) {
    if (typeof provider.drainUsage === 'function') {
      const dangling = provider.drainUsage()
      if (dangling.length > 0) await recordAiUsage(store, dangling, { blogId, workflowId: workflow.id })
    }
    workflow.status = 'failed'
    workflow.finishedAt = nowIso()
    workflow.decision = decision ?? workflow.decision
    workflow.metricId = snapshot?.id ?? workflow.metricId
    workflow.ideaId = idea?.id ?? workflow.ideaId
    workflow.articleId = article?.id ?? workflow.articleId
    workflow.approvalId = approval?.id ?? workflow.approvalId
    workflow.experimentId = experiment?.id ?? workflow.experimentId
    workflow.publishedRemoteId = article?.remoteId ?? published?.id ?? workflow.publishedRemoteId
    workflow.aiCostUsd = cycleCostUsd
    workflow.error = error.message
    await upsertWorkflow(store, workflow, { limit: 2000 })
    await recordActivity(store, { blogId, agent: 'system', type: 'cycle.failed', message: error.message, detail: { trigger: workflow.trigger, idempotencyKey: cycleKey || null } })
    throw error
  }
}

export async function runPortfolioCycle(store, options = {}) {
  const state = await store.read()
  if (state.system.paused) return { skipped: true, reason: 'system-paused', results: [] }

  const plan = buildPortfolioPlan(state)
  const byId = new Map(state.blogs.filter((blog) => blog.active).map((blog) => [blog.id, blog]))
  const ordered = plan.ranking.map((item) => byId.get(item.blogId)).filter(Boolean)
  const results = []
  for (const blog of ordered) {
    try {
      const childKey = options.idempotencyKey ? `${options.idempotencyKey}:${blog.id}` : null
      results.push({
        blogId: blog.id,
        ok: true,
        result: await runBlogCycle(store, blog.id, {
          trigger: options.trigger || 'portfolio',
          idempotencyKey: childKey,
        }),
      })
    } catch (error) {
      results.push({ blogId: blog.id, ok: false, error: error.message })
    }
  }
  return { skipped: false, plan, results }
}

export async function resolveApproval(store, approvalId, approved) {
  const snapshot = await store.read()
  const approval = snapshot.approvals.find((item) => item.id === approvalId)
  if (!approval) throw new Error('Approval not found')
  if (approval.status !== 'pending') throw new Error('Approval is already resolved')

  if (!approved) {
    await resolveApprovalAndArticle(store, {
      approvalId,
      approvalPatch: { status: 'rejected', resolvedAt: nowIso() },
    })
    return { status: 'rejected' }
  }

  const blog = snapshot.blogs.find((item) => item.id === approval.blogId)
  const article = approval.articleId ? snapshot.articles.find((item) => item.id === approval.articleId) : null

  if (approval.action === 'PUBLISH' && blog && article) {
    const connector = createConnector({ blog, store })
    const remote = await connector.createDraft(article)
    await connector.publishPost(remote.id)
    const updatedAt = nowIso()
    const resolved = await resolveApprovalAndArticle(store, {
      approvalId,
      approvalPatch: { status: 'approved', resolvedAt: updatedAt },
      articleId: article.id,
      articlePatch: { status: 'published', remoteId: remote.id, updatedAt },
    })
    const liveArticle = resolved.article ?? { ...article, status: 'published', remoteId: remote.id, updatedAt }
    const experiment = await startLiveExperiment(store, { blog, article: liveArticle, action: 'CREATE' })
    await recordActivity(store, { blogId: blog.id, agent: 'publisher', type: 'content.published.after-approval', message: `承認後に「${article.title}」を公開しました。`, detail: { articleId: article.id, remoteId: remote.id, experimentId: experiment?.id ?? null } })
    return { status: 'approved', published: true, remoteId: remote.id, experimentId: experiment?.id ?? null }
  }

  if (approval.action === 'UPDATE' && blog && article && approval.targetRemoteId !== null) {
    const connector = createConnector({ blog, store })
    const remote = await connector.updatePost(approval.targetRemoteId, { title: article.title, content: article.body })
    const updatedAt = nowIso()
    const resolved = await resolveApprovalAndArticle(store, {
      approvalId,
      approvalPatch: { status: 'approved', resolvedAt: updatedAt },
      articleId: article.id,
      articlePatch: { status: 'published', updatedAt },
    })
    const liveArticle = resolved.article ?? { ...article, status: 'published', updatedAt }
    const experiment = await startLiveExperiment(store, { blog, article: liveArticle, action: 'UPDATE' })
    await recordActivity(store, { blogId: blog.id, agent: 'publisher', type: 'content.updated.after-approval', message: `承認後に「${article.title}」の改稿を反映しました。`, detail: { articleId: article.id, remoteId: approval.targetRemoteId, experimentId: experiment?.id ?? null } })
    return { status: 'approved', updated: true, remoteId: remote.id ?? approval.targetRemoteId, experimentId: experiment?.id ?? null }
  }

  await resolveApprovalAndArticle(store, {
    approvalId,
    approvalPatch: { status: 'approved', resolvedAt: nowIso() },
  })
  return { status: 'approved', note: 'Action approved; it will be considered by the next cycle.' }
}

export async function setPaused(store, paused) {
  const at = nowIso()
  await store.mutate((state) => {
    state.system.paused = Boolean(paused)
    state.system.pausedAt = paused ? at : null
  })
  await recordActivity(store, { agent: 'human-control', type: paused ? 'system.paused' : 'system.resumed', message: paused ? 'すべてのAI自動運用を停止しました。' : 'AI自動運用を再開しました。' })
  return { paused: Boolean(paused), at }
}

export function summarizeHQ(state) {
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending')
  const published = state.articles.filter((item) => item.status === 'published')
  const drafts = state.articles.filter((item) => item.status === 'draft' || item.status === 'draft-update')
  const portfolio = buildPortfolioPlan(state)
  const ai = budgetStatus(state)
  const jobs = summarizeJobs(state)

  const blogs = state.blogs.map((blog) => {
    const latestMetric = state.analytics.find((item) => item.blogId === blog.id) ?? null
    const recentWorkflow = state.workflows.find((item) => item.blogId === blog.id) ?? null
    const blogApprovals = pendingApprovals.filter((item) => item.blogId === blog.id).length
    const portfolioEntry = portfolio.ranking.find((item) => item.blogId === blog.id) ?? null
    return {
      id: blog.id,
      name: blog.name,
      active: blog.active,
      connector: blog.connector.type,
      autonomyLevel: blog.autonomy.level,
      latestMetric,
      lastWorkflow: recentWorkflow,
      pendingApprovals: blogApprovals,
      portfolioScore: portfolioEntry?.score ?? null,
      growthPct: portfolioEntry?.growthPct ?? null,
    }
  })

  return {
    system: state.system,
    totals: {
      blogs: state.blogs.length,
      activeBlogs: state.blogs.filter((item) => item.active).length,
      drafts: drafts.length,
      published: published.length,
      pendingApprovals: pendingApprovals.length,
      activities: state.activities.length,
      runningExperiments: state.experiments.filter((item) => item.status === 'running').length,
      learnings: state.memories.filter((item) => item.type === 'experiment-learning').length,
      queuedJobs: jobs.queued,
      failedJobs: jobs.failed,
    },
    ai,
    jobs,
    blogs,
    portfolio,
    portfolioRecommendation: portfolio.recommendation,
    recentActivity: state.activities.slice(0, 12),
    pendingApprovals: pendingApprovals.slice(0, 20),
  }
}
