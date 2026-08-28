// @feature F-010

const METRIC_PRIORITY = ['clicks', 'views', 'sessions', 'impressions', 'users', 'published', 'posts']

function metricPoint(snapshot) {
  if (!snapshot) return { key: null, value: null }
  for (const key of METRIC_PRIORITY) {
    const value = snapshot[key]
    if (typeof value === 'number' && Number.isFinite(value)) return { key, value }
  }
  return { key: null, value: null }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function growthPct(previous, latest) {
  if (previous === null || latest === null) return 0
  if (previous === 0) return latest === 0 ? 0 : 100
  return ((latest - previous) / Math.abs(previous)) * 100
}

export function buildPortfolioPlan(state) {
  const activeBlogs = state.blogs.filter((blog) => blog.active)
  const ranking = activeBlogs.map((blog) => {
    const snapshots = state.analytics.filter((item) => item.blogId === blog.id).slice(0, 2)
    const latestPoint = metricPoint(snapshots[0])
    const previousPoint = metricPoint(snapshots[1])
    const comparable = latestPoint.key && latestPoint.key === previousPoint.key
    const growth = comparable ? growthPct(previousPoint.value, latestPoint.value) : 0
    const failures = state.workflows
      .filter((item) => item.blogId === blog.id)
      .slice(0, 5)
      .filter((item) => item.status === 'failed').length
    const approvals = state.approvals.filter((item) => item.blogId === blog.id && item.status === 'pending').length
    const experiments = state.experiments.filter((item) => item.blogId === blog.id && item.status === 'running').length
    const hasFreshSignal = snapshots.length > 0 ? 8 : 0
    const score = Math.round(
      50
      + clamp(growth, -25, 25)
      + hasFreshSignal
      + Math.min(experiments, 3) * 2
      - failures * 12
      - Math.min(approvals, 5) * 3,
    )
    return {
      blogId: blog.id,
      name: blog.name,
      score,
      signal: latestPoint.key,
      latestValue: latestPoint.value,
      growthPct: Number(growth.toFixed(1)),
      failures,
      pendingApprovals: approvals,
      runningExperiments: experiments,
    }
  }).sort((a, b) => b.score - a.score)

  let recommendation = '最初のブログを接続すると、Portfolio Brainが横断判断を開始します。'
  if (ranking.length > 0) {
    const blocked = ranking.filter((item) => item.pendingApprovals > 0)
    if (blocked.length > 0) {
      recommendation = `${blocked[0].name} などで承認待ちがあります。まず人間ゲートを解消すると自律ループが前へ進みます。`
    } else {
      const top = ranking[0]
      recommendation = `${top.name} を次の優先観測対象にします。Portfolio score ${top.score}${top.signal ? ` / ${top.signal} ${top.growthPct >= 0 ? '+' : ''}${top.growthPct}%` : ''}。`
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    ranking,
    recommendedBlogId: ranking[0]?.blogId ?? null,
    recommendation,
  }
}
