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
import { createConnector } from './connectors.js'
import { createId, nowIso } from './store.js'

const DEFAULT_AUTONOMY = {
  level: 2,
  allowCreate: true,
  allowUpdate: true,
  allowPublish: false,
  allowDelete: false,
}

export function sanitizeBlogInput(input = {}) {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('Blog name is required')

  const connectorType = input.connector?.type === 'wordpress' ? 'wordpress' : 'memory'
  const connector = connectorType === 'wordpress'
    ? {
        type: 'wordpress',
        endpoint: String(input.connector?.endpoint ?? '').trim(),
        usernameEnv: String(input.connector?.usernameEnv ?? '').trim(),
        passwordEnv: String(input.connector?.passwordEnv ?? '').trim(),
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
    brain: {
      purpose: String(input.brain?.purpose ?? '').trim(),
      audience: String(input.brain?.audience ?? '').trim(),
      voice: String(input.brain?.voice ?? '').trim(),
      editorialPolicy: String(input.brain?.editorialPolicy ?? '').trim(),
      monetization: String(input.brain?.monetization ?? '').trim(),
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

async function createApproval(store, { blogId, articleId, action, reason }) {
  const approval = {
    id: createId('approval'),
    blogId,
    articleId: articleId ?? null,
    action,
    reason,
    status: 'pending',
    createdAt: nowIso(),
    resolvedAt: null,
  }
  await store.mutate((state) => state.approvals.unshift(approval))
  return approval
}

export async function testConnection(store, blogId) {
  const state = await store.read()
  const blog = state.blogs.find((item) => item.id === blogId)
  if (!blog) throw new Error('Blog not found')
  const connector = createConnector({ blog, store })
  const [posts, metrics] = await Promise.all([connector.listPosts(3), connector.getMetrics()])
  return { ok: true, connector: blog.connector.type, samplePosts: posts.length, metrics }
}

export async function runBlogCycle(store, blogId, options = {}) {
  const startedAt = nowIso()
  const initial = await store.read()
  if (initial.system.paused) {
    return { skipped: true, reason: 'system-paused' }
  }

  const blog = initial.blogs.find((item) => item.id === blogId)
  if (!blog) throw new Error('Blog not found')
  if (!blog.active) return { skipped: true, reason: 'blog-inactive' }

  const workflow = {
    id: createId('workflow'),
    blogId,
    status: 'running',
    startedAt,
    finishedAt: null,
    decision: null,
    error: null,
  }
  await store.mutate((state) => state.workflows.unshift(workflow))

  try {
    await recordActivity(store, {
      blogId,
      agent: 'observer',
      type: 'cycle.observe',
      message: `${blog.name} の状態観測を開始しました。`,
    })

    const connector = createConnector({ blog, store })
    const [posts, metrics] = await Promise.all([connector.listPosts(30), connector.getMetrics()])
    const snapshot = {
      id: createId('metric'),
      blogId,
      capturedAt: nowIso(),
      source: metrics.source ?? blog.connector.type,
      ...metrics,
    }
    await store.mutate((state) => state.analytics.unshift(snapshot))

    const provider = options.provider ?? createAIProvider()
    const decision = await provider.decide({ blog, posts, metrics })
    workflow.decision = decision

    await recordActivity(store, {
      blogId,
      agent: 'director',
      type: 'cycle.decide',
      message: `${decision.action}: ${decision.rationale}`,
      detail: decision,
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
    await store.mutate((state) => state.ideas.unshift(idea))

    let article = null
    let approval = null
    let published = null

    if (decision.action === 'CREATE') {
      if (canExecute(blog, 'CREATE') && Number(blog.autonomy.level) >= 2) {
        const draft = await provider.draft({ blog, decision })
        article = {
          id: createId('article'),
          blogId,
          ideaId: idea.id,
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
          await recordActivity(store, {
            blogId,
            agent: 'publisher',
            type: 'content.published',
            message: `「${article.title}」を自動公開しました。`,
            detail: { articleId: article.id, remoteId: remote.id },
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
      approval = await createApproval(store, {
        blogId,
        action: 'UPDATE',
        reason: 'Foundation版では既存記事の自動改稿は承認キューへ送ります。',
      })
    }

    const finishedAt = nowIso()
    await store.mutate((state) => {
      state.system.lastCycleAt = finishedAt
      const saved = state.workflows.find((item) => item.id === workflow.id)
      saved.status = 'completed'
      saved.finishedAt = finishedAt
      saved.decision = decision
    })

    return { workflowId: workflow.id, decision, idea, article, approval, published, metrics }
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
    })
    throw error
  }
}

export async function runPortfolioCycle(store) {
  const state = await store.read()
  if (state.system.paused) return { skipped: true, reason: 'system-paused', results: [] }

  const activeBlogs = state.blogs.filter((blog) => blog.active)
  const results = []
  for (const blog of activeBlogs) {
    try {
      results.push({ blogId: blog.id, ok: true, result: await runBlogCycle(store, blog.id) })
    } catch (error) {
      results.push({ blogId: blog.id, ok: false, error: error.message })
    }
  }
  return { skipped: false, results }
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

  if (approval.action !== 'PUBLISH' || !approval.articleId) {
    await store.mutate((state) => {
      const saved = state.approvals.find((item) => item.id === approvalId)
      saved.status = 'approved'
      saved.resolvedAt = nowIso()
    })
    return { status: 'approved', note: 'Action approved; it will be considered by the next cycle.' }
  }

  const blog = snapshot.blogs.find((item) => item.id === approval.blogId)
  const article = snapshot.articles.find((item) => item.id === approval.articleId)
  if (!blog || !article) throw new Error('Approval target not found')

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
  await recordActivity(store, {
    blogId: blog.id,
    agent: 'publisher',
    type: 'content.published.after-approval',
    message: `承認後に「${article.title}」を公開しました。`,
    detail: { articleId: article.id, remoteId: remote.id },
  })
  return { status: 'approved', published: true, remoteId: remote.id }
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
  const drafts = state.articles.filter((item) => item.status === 'draft')

  const blogs = state.blogs.map((blog) => {
    const latestMetric = state.analytics.find((item) => item.blogId === blog.id) ?? null
    const recentWorkflow = state.workflows.find((item) => item.blogId === blog.id) ?? null
    const blogApprovals = pendingApprovals.filter((item) => item.blogId === blog.id).length
    return {
      id: blog.id,
      name: blog.name,
      active: blog.active,
      connector: blog.connector.type,
      autonomyLevel: blog.autonomy.level,
      latestMetric,
      lastWorkflow: recentWorkflow,
      pendingApprovals: blogApprovals,
    }
  })

  const portfolioRecommendation = blogs.length === 0
    ? '最初のブログを接続すると、Portfolio Brainが横断判断を開始します。'
    : pendingApprovals.length > 0
      ? `まず${pendingApprovals.length}件の承認待ちを確認すると運用ループが前へ進みます。`
      : '重大な承認待ちはありません。次の観測サイクルを実行できます。'

  return {
    system: state.system,
    totals: {
      blogs: state.blogs.length,
      activeBlogs: state.blogs.filter((item) => item.active).length,
      drafts: drafts.length,
      published: published.length,
      pendingApprovals: pendingApprovals.length,
      activities: state.activities.length,
    },
    blogs,
    portfolioRecommendation,
    recentActivity: state.activities.slice(0, 12),
    pendingApprovals: pendingApprovals.slice(0, 20),
  }
}
