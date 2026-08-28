// @feature F-001
// @feature F-002
// @feature F-004
// @feature F-006
// @feature F-007
// @feature F-008
// @feature F-009
// @feature F-010
// @feature F-011
import { createAIProvider } from './ai.js'
import { collectAnalytics } from './analytics.js'
import { createConnector } from './connectors.js'
import { evaluateExperiments, recentLearnings, startExperiment } from './experiments.js'
import { buildPortfolioPlan } from './portfolio.js'
import { createId, nowIso } from './store.js'

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

export function sanitizeBlogInput(input = {}) {
  const name = cleanString(input.name)
  if (!name) throw new Error('Blog name is required')

  const connectorType = input.connector?.type === 'wordpress' ? 'wordpress' : 'memory'
  const connector = connectorType === 'wordpress'
    ? {
        type: 'wordpress',
        endpoint: cleanString(input.connector?.endpoint),
        usernameEnv: cleanString(input.connector?.usernameEnv),
        passwordEnv: cleanString(input.connector?.passwordEnv),
      }
    : { type: 'memory' }

  if (connectorType === 'wordpress' && !connector.endpoint) {
    throw new Error('WordPress endpoint is required')
  }

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
    brain: {
      purpose: cleanString(input.brain?.purpose),
      audience: cleanString(input.brain?.audience),
      voice: cleanString(input.brain?.voice),
      editorialPolicy: cleanString(input.brain?.editorialPolicy),
      monetization: cleanString(input.brain?.monetization),
      topics: Array.isArray(input.brain?.topics)
        ? input.brain.topics.map((item) => String(item).trim()).filter(Boolean).slice(0, 30)
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
    if (state.blogs.some((item) => item.slug === blog.slug)) {
      throw new Error('A blog with this slug already exists')
    }
    state.blogs.push(blog)
  })
  await recordActivity(store, {
    blogId: blog.id,
    agent: 'system',
    type: 'blog.connected',
    message: `${blog.name} をBloggers HQへ登録しました。`,
  })
  return blog
}

export async function updateBlog(store, blogId, changes) {
  return store.mutate((state) => {
    const blog = state.blogs.find((item) => item.id === blogId)
    if (!blog) throw new Error('Blog not found')

    if (changes.brain) blog.brain = { ...blog.brain, ...changes.brain }
    if (changes.analytics) blog.analytics = sanitizeAnalytics({ ...blog.analytics, ...changes.analytics })
    if (changes.autonomy) {
      const level = Math.max(0, Math.min(5, Number(changes.autonomy.level ?? blog.autonomy.level)))
      blog.autonomy = { ...blog.autonomy, ...changes.autonomy, level, allowDelete: false }
    }
    if (typeof changes.active === 'boolean') blog.active = changes.active
    blog.updatedAt = nowIso()
    return structuredClone(blog)
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
  await store.mutate((state) => {
    state.activities.unshift(activity)
    state.activities = state.activities.slice(0, 1000)
  })
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

async function createApproval(store, { blogId, articleId, action, reason, targetRemoteId = null }) {
  const approval = {
    id: createId('approval'),
    blogId,
    articleId: articleId ?? null,
    targetRemoteId,
    action,
    reason,
    status: 'pending',
    createdAt: nowIso(),
    resolvedAt: null,
  }
  await store.mutate((state) => state.approvals.unshift(approval))
  return approval
}

async function startLiveExperiment(store, { blog, article, action, snapshot = null }) {
  const state = await store.read()
  const idea = state.ideas.find((item) => item.id === article.ideaId)
  const baseline = snapshot ?? state.analytics.find((item) => item.blogId === blog.id) ?? null
  if (!baseline) return null
  return startExperiment(store, {
    blog,
    decision: {
      action,
      rationale: idea?.rationale || `${action}施策が主要指標を改善するか検証する。`,
    },
    snapshot: baseline,
    ideaId: article.ideaId,
    articleId: article.id,
  })
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

  const workflow = {
    id: createId('workflow'),
    blogId,
    trigger: options.trigger || 'manual',
    status: 'running',
    startedAt,
    finishedAt: null,
    decision: null,
    experimentId: null,
    error: null,
  }
  await store.mutate((state) => {
    state.workflows.unshift(workflow)
    state.workflows = state.workflows.slice(0, 2000)
  })

  try {
    await recordActivity(store, {
      blogId,
      agent: 'observer',
      type: 'cycle.observe',
      message: `${blog.name} の状態観測を開始しました。`,
      detail: { trigger: workflow.trigger },
    })

    const connector = createConnector({ blog, store })
    const [posts, cmsMetrics] = await Promise.all([connector.listPosts(30), connector.getMetrics()])
    const metrics = await collectAnalytics(blog, cmsMetrics)
    const snapshot = { id: createId('metric'), blogId, capturedAt: nowIso(), ...metrics }
    await store.mutate((state) => {
      state.analytics.unshift(snapshot)
      state.analytics = state.analytics.slice(0, 5000)
    })

    if (metrics.warnings?.length) {
      await recordActivity(store, {
        blogId,
        agent: 'observer',
        type: 'analytics.partial',
        message: `${metrics.warnings.length}個のAnalytics sourceを取得できませんでしたが、利用可能なデータで継続します。`,
        detail: metrics.warnings,
      })
    }

    const evaluation = await evaluateExperiments(store, blogId, snapshot)
    for (const completed of evaluation.completed) {
      await recordActivity(store, {
        blogId,
        agent: 'learner',
        type: 'experiment.completed',
        message: `実験結果をBlog Memoryへ保存しました: ${completed.result} / ${completed.targetMetric} ${Number(completed.deltaPct || 0).toFixed(1)}%`,
        detail: { experimentId: completed.id },
      })
    }

    const stateWithLearning = await store.read()
    const learnings = recentLearnings(stateWithLearning, blogId)
    const provider = options.provider ?? createAIProvider()
    const decision = await provider.decide({ blog, posts, metrics, learnings })
    workflow.decision = decision

    await recordActivity(store, {
      blogId,
      agent: 'director',
      type: 'cycle.decide',
      message: `${decision.action}: ${decision.rationale}`,
      detail: { ...decision, learningsUsed: learnings.length },
    })

    const idea = {
      id: createId('idea'),
      blogId,
      action: decision.action,
      topic: decision.topic ?? '',
      title: decision.title ?? '',
      rationale: decision.rationale ?? '',
      confidence: Number(decision.confidence ?? 0),
      status: decision.action === 'WAIT' ? 'observing' : 'proposed',
      createdAt: nowIso(),
    }
    await store.mutate((state) => {
      state.ideas.unshift(idea)
      state.ideas = state.ideas.slice(0, 3000)
    })

    let article = null
    let approval = null
    let published = null
    let experiment = null

    if (decision.action === 'CREATE') {
      if (canExecute(blog, 'CREATE') && Number(blog.autonomy.level) >= 2) {
        const draft = await provider.draft({ blog, decision, learnings })
        article = {
          id: createId('article'),
          blogId,
          ideaId: idea.id,
          action: 'CREATE',
          title: draft.title,
          body: draft.body,
          status: 'draft',
          provider: draft.provider,
          remoteId: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        await store.mutate((state) => state.articles.unshift(article))
        await recordActivity(store, {
          blogId,
          agent: 'writer',
          type: 'content.drafted',
          message: `「${article.title}」の下書きを作成しました。`,
          detail: { articleId: article.id, provider: article.provider },
        })

        if (canExecute(blog, 'PUBLISH')) {
          const remote = await connector.createDraft(article)
          published = await connector.publishPost(remote.id)
          await store.mutate((state) => {
            const saved = state.articles.find((item) => item.id === article.id)
            saved.status = 'published'
            saved.remoteId = remote.id
            saved.updatedAt = nowIso()
          })
          experiment = await startLiveExperiment(store, { blog, article, action: 'CREATE', snapshot })
          await recordActivity(store, {
            blogId,
            agent: 'publisher',
            type: 'content.published',
            message: `「${article.title}」を自動公開しました。`,
            detail: { articleId: article.id, remoteId: remote.id, experimentId: experiment?.id ?? null },
          })
        } else if (needsApproval(blog, 'PUBLISH')) {
          approval = await createApproval(store, {
            blogId,
            articleId: article.id,
            action: 'PUBLISH',
            reason: '現在の自動運用レベルでは公開に人間の承認が必要です。',
          })
          await recordActivity(store, {
            blogId,
            agent: 'editor',
            type: 'approval.requested',
            message: `「${article.title}」の公開承認を待っています。`,
            detail: { approvalId: approval.id },
          })
        }
      } else {
        approval = await createApproval(store, {
          blogId,
          action: 'CREATE',
          reason: '現在の自動運用レベルでは下書き作成前に承認が必要です。',
        })
      }
    } else if (decision.action === 'UPDATE') {
      const target = posts.find((post) => String(post.id) === String(decision.targetPostId))
      if (!target) throw new Error('UPDATE target post was not found')

      if (canExecute(blog, 'UPDATE') && Number(blog.autonomy.level) >= 2) {
        const revision = await provider.revise({ blog, decision, post: target, learnings })
        article = {
          id: createId('article'),
          blogId,
          ideaId: idea.id,
          action: 'UPDATE',
          title: revision.title,
          body: revision.body,
          status: 'draft-update',
          provider: revision.provider,
          remoteId: target.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        await store.mutate((state) => state.articles.unshift(article))
        await recordActivity(store, {
          blogId,
          agent: 'writer',
          type: 'content.revision-drafted',
          message: `「${article.title}」の改稿案を作成しました。`,
          detail: { articleId: article.id, remoteId: target.id },
        })

        if (canExecute(blog, 'PUBLISH')) {
          published = await connector.updatePost(target.id, { title: article.title, content: article.body })
          await store.mutate((state) => {
            const saved = state.articles.find((item) => item.id === article.id)
            saved.status = 'published'
            saved.updatedAt = nowIso()
          })
          experiment = await startLiveExperiment(store, { blog, article, action: 'UPDATE', snapshot })
          await recordActivity(store, {
            blogId,
            agent: 'publisher',
            type: 'content.updated',
            message: `「${article.title}」の改稿を自動反映しました。`,
            detail: { articleId: article.id, remoteId: target.id, experimentId: experiment?.id ?? null },
          })
        } else {
          approval = await createApproval(store, {
            blogId,
            articleId: article.id,
            targetRemoteId: target.id,
            action: 'UPDATE',
            reason: '既存記事の改稿反映には人間の承認が必要です。',
          })
          await recordActivity(store, {
            blogId,
            agent: 'editor',
            type: 'approval.requested',
            message: `「${article.title}」の改稿反映を待っています。`,
            detail: { approvalId: approval.id, remoteId: target.id },
          })
        }
      } else {
        approval = await createApproval(store, {
          blogId,
          action: 'UPDATE',
          targetRemoteId: target.id,
          reason: '現在の自動運用レベルでは改稿案の作成前に承認が必要です。',
        })
      }
    }

    const finishedAt = nowIso()
    await store.mutate((state) => {
      state.system.lastCycleAt = finishedAt
      const saved = state.workflows.find((item) => item.id === workflow.id)
      saved.status = 'completed'
      saved.finishedAt = finishedAt
      saved.decision = decision
      saved.experimentId = experiment?.id ?? null
    })

    return { workflowId: workflow.id, decision, idea, article, approval, published, experiment, evaluation, metrics }
  } catch (error) {
    await store.mutate((state) => {
      const saved = state.workflows.find((item) => item.id === workflow.id)
      if (saved) {
        saved.status = 'failed'
        saved.finishedAt = nowIso()
        saved.error = error.message
      }
    })
    await recordActivity(store, {
      blogId,
      agent: 'system',
      type: 'cycle.failed',
      message: error.message,
      detail: { trigger: workflow.trigger },
    })
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
      results.push({ blogId: blog.id, ok: true, result: await runBlogCycle(store, blog.id, { trigger: options.trigger || 'portfolio' }) })
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
    await store.mutate((state) => {
      const saved = state.approvals.find((item) => item.id === approvalId)
      saved.status = 'rejected'
      saved.resolvedAt = nowIso()
    })
    return { status: 'rejected' }
  }

  const blog = snapshot.blogs.find((item) => item.id === approval.blogId)
  const article = approval.articleId ? snapshot.articles.find((item) => item.id === approval.articleId) : null

  if (approval.action === 'PUBLISH' && blog && article) {
    const connector = createConnector({ blog, store })
    const remote = await connector.createDraft(article)
    await connector.publishPost(remote.id)
    await store.mutate((state) => {
      const savedApproval = state.approvals.find((item) => item.id === approvalId)
      savedApproval.status = 'approved'
      savedApproval.resolvedAt = nowIso()
      const savedArticle = state.articles.find((item) => item.id === article.id)
      savedArticle.status = 'published'
      savedArticle.remoteId = remote.id
      savedArticle.updatedAt = nowIso()
    })
    const experiment = await startLiveExperiment(store, { blog, article, action: 'CREATE' })
    await recordActivity(store, {
      blogId: blog.id,
      agent: 'publisher',
      type: 'content.published.after-approval',
      message: `承認後に「${article.title}」を公開しました。`,
      detail: { articleId: article.id, remoteId: remote.id, experimentId: experiment?.id ?? null },
    })
    return { status: 'approved', published: true, remoteId: remote.id, experimentId: experiment?.id ?? null }
  }

  if (approval.action === 'UPDATE' && blog && article && approval.targetRemoteId !== null) {
    const connector = createConnector({ blog, store })
    const remote = await connector.updatePost(approval.targetRemoteId, { title: article.title, content: article.body })
    await store.mutate((state) => {
      const savedApproval = state.approvals.find((item) => item.id === approvalId)
      savedApproval.status = 'approved'
      savedApproval.resolvedAt = nowIso()
      const savedArticle = state.articles.find((item) => item.id === article.id)
      savedArticle.status = 'published'
      savedArticle.updatedAt = nowIso()
    })
    const experiment = await startLiveExperiment(store, { blog, article, action: 'UPDATE' })
    await recordActivity(store, {
      blogId: blog.id,
      agent: 'publisher',
      type: 'content.updated.after-approval',
      message: `承認後に「${article.title}」の改稿を反映しました。`,
      detail: { articleId: article.id, remoteId: approval.targetRemoteId, experimentId: experiment?.id ?? null },
    })
    return { status: 'approved', updated: true, remoteId: remote.id ?? approval.targetRemoteId, experimentId: experiment?.id ?? null }
  }

  await store.mutate((state) => {
    const saved = state.approvals.find((item) => item.id === approvalId)
    saved.status = 'approved'
    saved.resolvedAt = nowIso()
  })
  return { status: 'approved', note: 'Action approved; it will be considered by the next cycle.' }
}

export async function setPaused(store, paused) {
  const at = nowIso()
  await store.mutate((state) => {
    state.system.paused = Boolean(paused)
    state.system.pausedAt = paused ? at : null
  })
  await recordActivity(store, {
    agent: 'human-control',
    type: paused ? 'system.paused' : 'system.resumed',
    message: paused ? 'すべてのAI自動運用を停止しました。' : 'AI自動運用を再開しました。',
  })
  return { paused: Boolean(paused), at }
}

export function summarizeHQ(state) {
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending')
  const published = state.articles.filter((item) => item.status === 'published')
  const drafts = state.articles.filter((item) => item.status === 'draft' || item.status === 'draft-update')
  const portfolio = buildPortfolioPlan(state)

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
    },
    blogs,
    portfolio,
    portfolioRecommendation: portfolio.recommendation,
    recentActivity: state.activities.slice(0, 12),
    pendingApprovals: pendingApprovals.slice(0, 20),
  }
}
