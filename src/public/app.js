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
const view = document.querySelector('#view')
const title = document.querySelector('#view-title')
const eyebrow = document.querySelector('#view-eyebrow')
const notice = document.querySelector('#notice')
const pauseButton = document.querySelector('#pause-button')
const cycleButton = document.querySelector('#cycle-button')
const systemDot = document.querySelector('#system-dot')
const systemLabel = document.querySelector('#system-label')

let currentView = 'hq'
let cache = {
  hq: null,
  blogs: [],
  content: { ideas: [], articles: [], approvals: [] },
  analytics: { analytics: [], experiments: [], memories: [] },
  activity: { activities: [], workflows: [] },
  settings: null,
  jobs: [],
}

const labels = {
  hq: ['PORTFOLIO CONTROL', 'Bloggers HQ'],
  blogs: ['BLOG BRAINS', 'Blogs'],
  content: ['EDITORIAL PIPELINE', 'Content'],
  analytics: ['OBSERVE & LEARN', 'Analytics'],
  ai: ['AGENT ACTIVITY', 'AI'],
  settings: ['CONTROL & CONNECTIONS', 'Settings'],
}

function h(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function fmtDate(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function usd(value) {
  return `$${Number(value || 0).toFixed(4)}`
}

function authToken() {
  return sessionStorage.getItem('bloggersAdminToken') || ''
}

async function request(path, options = {}, allowPrompt = true) {
  const token = authToken()
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(path, { ...options, headers })
  if (response.status === 401 && allowPrompt) {
    const entered = window.prompt('Bloggers HQ 管理トークンを入力してください')
    if (entered) {
      sessionStorage.setItem('bloggersAdminToken', entered.trim())
      return request(path, options, false)
    }
  }
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

function flash(message, kind = 'info') {
  notice.hidden = false
  notice.dataset.kind = kind
  notice.textContent = message
  clearTimeout(flash.timer)
  flash.timer = setTimeout(() => { notice.hidden = true }, 5000)
}

async function loadAll() {
  const [hq, blogs, content, analytics, activity, settings, jobs] = await Promise.all([
    request('/api/hq'),
    request('/api/blogs'),
    request('/api/content'),
    request('/api/analytics'),
    request('/api/activity?limit=120'),
    request('/api/settings'),
    request('/api/jobs'),
  ])
  cache = { hq, blogs: blogs.blogs, content, analytics, activity, settings, jobs: jobs.jobs }
  updateSystemState()
}

function updateSystemState() {
  const paused = Boolean(cache.hq?.system?.paused)
  const scheduler = cache.hq?.system?.scheduler
  systemDot.classList.toggle('is-paused', paused)
  systemLabel.textContent = paused
    ? 'AI停止中'
    : scheduler?.enabled
      ? `自律運転 ON · ${scheduler.intervalMinutes}分`
      : 'AI稼働可能'
  pauseButton.textContent = paused ? 'RESUME AI' : 'PAUSE ALL AI'
  pauseButton.classList.toggle('button-danger', !paused)
  pauseButton.classList.toggle('button-primary', paused)
  cycleButton.disabled = paused
}

function metric(label, value, detail = '') {
  return `<article class="metric-card"><span>${h(label)}</span><strong>${h(value)}</strong><small>${h(detail)}</small></article>`
}

function renderHQ() {
  const data = cache.hq
  const blogRows = data.blogs.length
    ? data.blogs.map((blog) => `
      <article class="blog-row">
        <div><span class="connector-pill">${h(blog.connector)}</span><h3>${h(blog.name)}</h3><p>Autonomy L${h(blog.autonomyLevel)} · Score ${h(blog.portfolioScore ?? '—')} · 承認待ち ${h(blog.pendingApprovals)}</p></div>
        <div class="blog-row-status"><strong>${blog.latestMetric ? `${h(blog.latestMetric.clicks ?? blog.latestMetric.views ?? blog.latestMetric.posts ?? 0)} ${blog.latestMetric.clicks !== undefined ? 'clicks' : blog.latestMetric.views !== undefined ? 'views' : 'posts'}` : '未観測'}</strong><small>${blog.lastWorkflow ? fmtDate(blog.lastWorkflow.finishedAt || blog.lastWorkflow.startedAt) : 'サイクル未実行'}</small></div>
      </article>`).join('')
    : '<div class="empty-state"><strong>まだブログが接続されていません。</strong><p>Blogsから最初のBlog Brainを作成すると、AI編集部が動き始めます。</p></div>'

  const approvals = data.pendingApprovals.length
    ? data.pendingApprovals.map((item) => `<div class="approval-row"><div><strong>${h(item.action)}</strong><p>${h(item.reason)}</p></div><button class="button button-small" data-approve="${h(item.id)}">承認</button></div>`).join('')
    : '<p class="muted">承認待ちはありません。</p>'

  const ranking = data.portfolio?.ranking?.length
    ? data.portfolio.ranking.slice(0, 5).map((item, index) => `<div class="idea-row"><strong>#${index + 1}</strong><div><h3>${h(item.name)}</h3><p>score ${h(item.score)} · ${h(item.signal || '観測待ち')} ${h(item.growthPct)}%</p></div></div>`).join('')
    : '<p class="muted">Portfolio rankingはまだありません。</p>'

  view.innerHTML = `
    <div class="metrics-grid">
      ${metric('Blogs', data.totals.blogs, `${data.totals.activeBlogs} active`)}
      ${metric('Drafts', data.totals.drafts, 'AIが作成した下書き')}
      ${metric('Published', data.totals.published, 'Bloggers経由の公開')}
      ${metric('Approvals', data.totals.pendingApprovals, '人間の判断待ち')}
      ${metric('Experiments', data.totals.runningExperiments, '検証中')}
      ${metric('AI Spend', usd(data.ai?.usage?.totalUsd), `${data.ai?.usage?.calls ?? 0} calls / ${h(data.ai?.usage?.month || '')}`)}
      ${metric('Queued Jobs', data.totals.queuedJobs, `${data.totals.failedJobs} failed`)}
    </div>
    <div class="hero-panel"><div><p class="eyebrow">PORTFOLIO BRAIN</p><h2>いま全体で何をすべきか</h2></div><p class="hero-message">${h(data.portfolioRecommendation)}</p></div>
    <div class="two-column">
      <section class="panel"><div class="panel-heading"><div><p class="eyebrow">BLOG NETWORK</p><h2>ブログ群</h2></div></div><div class="stack">${blogRows}</div></section>
      <section class="panel"><div class="panel-heading"><div><p class="eyebrow">PORTFOLIO ORDER</p><h2>優先順位</h2></div></div><div class="stack">${ranking}</div></section>
    </div>
    <section class="panel"><div class="panel-heading"><div><p class="eyebrow">HUMAN GATE</p><h2>承認待ち</h2></div></div><div class="stack">${approvals}</div></section>`
}

function analyticsLabels(blog) {
  const labels = []
  if (blog.analytics?.searchConsole?.siteUrl) labels.push('GSC')
  if (blog.analytics?.ga4?.propertyId) labels.push('GA4')
  if (blog.analytics?.http?.endpoint) labels.push('HTTP')
  return labels.length ? labels.join(' + ') : 'CMS only'
}

function researchLabel(blog) {
  const count = blog.research?.sources?.length || 0
  if (!count) return '未設定'
  return `${count} sources${blog.research?.requireCitations ? ' / citations required' : ''}`
}

function renderBlogs() {
  const template = document.querySelector('#blog-form-template')
  const cards = cache.blogs.length
    ? cache.blogs.map((blog) => `
      <article class="panel blog-card">
        <div class="panel-heading"><div><span class="connector-pill">${h(blog.connector.type)}</span><h2>${h(blog.name)}</h2></div><span class="state-badge">L${h(blog.autonomy.level)}</span></div>
        <dl class="brain-grid">
          <div><dt>Purpose</dt><dd>${h(blog.brain.purpose || '未設定')}</dd></div>
          <div><dt>Audience</dt><dd>${h(blog.brain.audience || '未設定')}</dd></div>
          <div><dt>Voice</dt><dd>${h(blog.brain.voice || '未設定')}</dd></div>
          <div><dt>Topics</dt><dd>${h((blog.brain.topics || []).join(' / ') || '未設定')}</dd></div>
          <div><dt>Research</dt><dd>${h(researchLabel(blog))}</dd></div>
          <div><dt>Analytics</dt><dd>${h(analyticsLabels(blog))}</dd></div>
        </dl>
        <div class="inline-controls">
          <label>Autonomy<select data-autonomy="${h(blog.id)}">${[0,1,2,3,4,5].map((level) => `<option value="${level}" ${level === Number(blog.autonomy.level) ? 'selected' : ''}>Level ${level}</option>`).join('')}</select></label>
          <button class="button button-ghost" data-test-blog="${h(blog.id)}">接続テスト</button>
          <button class="button button-primary" data-run-blog="${h(blog.id)}">このブログだけ運用</button>
        </div>
      </article>`).join('')
    : '<div class="empty-state"><strong>Blog Brainはまだありません。</strong><p>下のフォームから最初のブログを登録してください。</p></div>'
  view.innerHTML = `<div class="stack">${cards}</div><div id="blog-form-host"></div>`
  document.querySelector('#blog-form-host').append(template.content.cloneNode(true))
  bindBlogForm()
}

function qualitySummary(article) {
  if (!article.quality) return 'quality未評価'
  if (!article.quality.ok) return `BLOCK · ${article.quality.blocking.join(' / ')}`
  const notes = []
  if (article.quality.citedSources?.length) notes.push(`${article.quality.citedSources.length} cited`)
  if (article.quality.linkedInternalPosts?.length) notes.push(`${article.quality.linkedInternalPosts.length} internal links`)
  if (article.quality.warnings?.length) notes.push(`${article.quality.warnings.length} warnings`)
  return notes.length ? notes.join(' · ') : 'quality OK'
}

function renderContent() {
  const articles = cache.content.articles.length
    ? cache.content.articles.map((article) => {
        const blog = cache.blogs.find((item) => item.id === article.blogId)
        return `<article class="content-row"><div><span class="state-badge">${h(article.status)}</span><h3>${h(article.title)}</h3><p>${h(blog?.name || 'Unknown blog')} · ${fmtDate(article.createdAt)}</p><small>${h(qualitySummary(article))}</small></div><small>${h(article.provider || '')}</small></article>`
      }).join('')
    : '<p class="muted">AIが作成した記事はまだありません。</p>'
  const ideas = cache.content.ideas.length
    ? cache.content.ideas.slice(0, 20).map((idea) => `<div class="idea-row"><strong>${h(idea.action)}</strong><div><h3>${h(idea.title || idea.topic)}</h3><p>${h(idea.rationale)}</p></div></div>`).join('')
    : '<p class="muted">企画はまだありません。</p>'
  view.innerHTML = `<div class="two-column"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">ARTICLES</p><h2>制作物</h2></div></div><div class="stack">${articles}</div></section><section class="panel"><div class="panel-heading"><div><p class="eyebrow">OPPORTUNITIES</p><h2>AIの企画判断</h2></div></div><div class="stack">${ideas}</div></section></div>`
}

function renderAnalytics() {
  const rows = cache.analytics.analytics.length
    ? cache.analytics.analytics.map((item) => {
        const blog = cache.blogs.find((entry) => entry.id === item.blogId)
        return `<tr><td>${h(blog?.name || item.blogId)}</td><td>${h(item.source)}</td><td>${h(item.clicks ?? '—')}</td><td>${h(item.views ?? '—')}</td><td>${h(item.impressions ?? '—')}</td><td>${h(item.posts ?? '—')}</td><td>${fmtDate(item.capturedAt)}</td></tr>`
      }).join('')
    : '<tr><td colspan="7">まだ観測データがありません。AI運用サイクルを実行してください。</td></tr>'
  const experiments = cache.analytics.experiments.length
    ? cache.analytics.experiments.slice(0, 20).map((item) => `<div class="idea-row"><strong>${h(item.status)}</strong><div><h3>${h(item.action)} · ${h(item.targetMetric)}</h3><p>${h(item.hypothesis)} / Δ ${h(Number(item.deltaPct || 0).toFixed(1))}% / obs ${h(item.observations)}</p></div></div>`).join('')
    : '<p class="muted">まだ実験はありません。公開・改稿が実際に反映されると自動で始まります。</p>'
  const memories = cache.analytics.memories.length
    ? cache.analytics.memories.slice(0, 20).map((item) => `<div class="activity-row"><time>${fmtDate(item.createdAt)}</time><span class="agent-name">learned</span><div><p>${h(item.text)}</p><small>confidence ${h(Number(item.confidence || 0).toFixed(2))}</small></div></div>`).join('')
    : '<p class="muted">確定した学習はまだありません。</p>'
  view.innerHTML = `
    <section class="panel"><div class="panel-heading"><div><p class="eyebrow">MEASUREMENT</p><h2>観測スナップショット</h2></div><p class="muted">CMS + Search Console + GA4 + Custom Metricsを統合します。</p></div><div class="table-wrap"><table><thead><tr><th>Blog</th><th>Source</th><th>Clicks</th><th>Views</th><th>Impressions</th><th>Posts</th><th>Captured</th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <div class="two-column"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">EXPERIMENTS</p><h2>仮説 → 検証</h2></div></div><div class="stack">${experiments}</div></section><section class="panel"><div class="panel-heading"><div><p class="eyebrow">BLOG MEMORY</p><h2>学習済み知見</h2></div></div><div class="timeline">${memories}</div></section></div>`
}

function renderAI() {
  const activities = cache.activity.activities.length
    ? cache.activity.activities.map((item) => {
        const blog = cache.blogs.find((entry) => entry.id === item.blogId)
        return `<div class="activity-row"><time>${fmtDate(item.createdAt)}</time><span class="agent-name">${h(item.agent)}</span><div><strong>${h(item.type)}</strong><p>${h(item.message)}</p>${blog ? `<small>${h(blog.name)}</small>` : ''}</div></div>`
      }).join('')
    : '<p class="muted">AI活動ログはまだありません。</p>'
  const jobs = cache.jobs.length
    ? cache.jobs.slice(0, 30).map((job) => `<div class="activity-row"><time>${fmtDate(job.updatedAt)}</time><span class="agent-name">${h(job.status)}</span><div><strong>${h(job.type)}</strong><p>${h(job.blogId || 'portfolio')} · attempt ${h(job.attempt)}/${h(job.maxAttempts)}</p>${job.lastError ? `<small>${h(job.lastError)}</small>` : ''}</div></div>`).join('')
    : '<p class="muted">Job Queueは空です。</p>'
  view.innerHTML = `<div class="two-column"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">AUDIT TRAIL</p><h2>AI Activity</h2></div></div><div class="timeline">${activities}</div></section><section class="panel"><div class="panel-heading"><div><p class="eyebrow">DURABLE QUEUE</p><h2>Jobs</h2></div></div><div class="timeline">${jobs}</div></section></div>`
}

function renderSettings() {
  const settings = cache.settings
  const scheduler = settings.system.scheduler || {}
  const budget = settings.system.aiBudget || {}
  const usage = cache.hq.ai?.usage || {}
  const models = settings.ai.models || {}
  view.innerHTML = `
    <div class="two-column">
      <section class="panel"><div class="panel-heading"><div><p class="eyebrow">AI ROUTER</p><h2>推論エンジン</h2></div></div><dl class="brain-grid"><div><dt>Mode</dt><dd>${h(settings.ai.mode)}</dd></div><div><dt>Director</dt><dd>${h(models.decide || 'local')}</dd></div><div><dt>Writer</dt><dd>${h(models.write || 'local')}</dd></div><div><dt>Reviser</dt><dd>${h(models.revise || 'local')}</dd></div></dl><p class="muted">役割ごとに別モデルを指定できます。token usageはCost Governorへ記録されます。</p></section>
      <section class="panel"><div class="panel-heading"><div><p class="eyebrow">SAFETY</p><h2>Human Control</h2></div></div><p>${settings.system.paused ? '現在、全AI操作は停止しています。' : 'AIは各ブログのAutonomy Policyと品質ゲートの範囲内でのみ動きます。'}</p><p class="muted">削除は禁止。外部公開時はBLOGGERS_ADMIN_TOKENでAPIを保護します。</p><button class="button button-ghost" id="forget-token">この端末の管理トークンを忘れる</button></section>
    </div>
    <form class="panel form-grid" id="budget-form">
      <div class="panel-heading"><div><p class="eyebrow">COST GOVERNOR</p><h2>AI予算</h2></div><p class="muted">今月 ${usd(usage.totalUsd)} / ${usage.calls || 0} calls。価格を環境変数へ設定すると概算費用を自動計算します。</p></div>
      <label>状態<select name="enabled"><option value="true" ${budget.enabled === false ? '' : 'selected'}>ON</option><option value="false" ${budget.enabled === false ? 'selected' : ''}>OFF</option></select></label>
      <label>月間上限 USD<input name="monthlyUsd" type="number" min="0" step="0.01" value="${h(budget.monthlyUsd ?? 20)}"></label>
      <label>1サイクル上限 USD<input name="perCycleUsd" type="number" min="0" step="0.01" value="${h(budget.perCycleUsd ?? 2)}"></label>
      <label>残して停止する額 USD<input name="reserveUsd" type="number" min="0" step="0.01" value="${h(budget.reserveUsd ?? 0.5)}"></label>
      <div class="form-actions wide"><button class="button button-primary" type="submit">AI予算を保存</button></div>
    </form>
    <form class="panel form-grid" id="scheduler-form">
      <div class="panel-heading"><div><p class="eyebrow">AUTONOMOUS SCHEDULER</p><h2>定時自律運転</h2></div><p class="muted">永続Job Queueへ先に登録してから実行するため、途中終了してもlease切れ後に回収できます。</p></div>
      <label>状態<select name="enabled"><option value="false" ${scheduler.enabled ? '' : 'selected'}>OFF</option><option value="true" ${scheduler.enabled ? 'selected' : ''}>ON</option></select></label>
      <label>間隔（分）<input name="intervalMinutes" type="number" min="15" max="10080" value="${h(scheduler.intervalMinutes ?? 360)}"></label>
      <label>最大リトライ<input name="maxRetries" type="number" min="0" max="5" value="${h(scheduler.maxRetries ?? 2)}"></label>
      <label>リトライ間隔（分）<input name="retryDelayMinutes" type="number" min="1" max="1440" value="${h(scheduler.retryDelayMinutes ?? 10)}"></label>
      <div><dt>Last run</dt><dd>${fmtDate(scheduler.lastRunAt)}</dd></div><div><dt>Next run</dt><dd>${fmtDate(scheduler.nextRunAt)}</dd></div>
      <div class="form-actions wide"><button class="button button-primary" type="submit">Scheduler設定を保存</button></div>
    </form>`

  document.querySelector('#forget-token').addEventListener('click', () => {
    sessionStorage.removeItem('bloggersAdminToken')
    flash('このブラウザに保持した管理トークンを削除しました。')
  })
  document.querySelector('#budget-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await request('/api/settings/ai-budget', { method: 'PATCH', body: JSON.stringify({ enabled: data.get('enabled') === 'true', monthlyUsd: Number(data.get('monthlyUsd')), perCycleUsd: Number(data.get('perCycleUsd')), reserveUsd: Number(data.get('reserveUsd')) }) })
      await refresh('AI予算を保存しました。')
    } catch (error) { flash(error.message, 'error') }
  })
  document.querySelector('#scheduler-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await request('/api/settings/scheduler', { method: 'PATCH', body: JSON.stringify({ enabled: data.get('enabled') === 'true', intervalMinutes: Number(data.get('intervalMinutes')), maxRetries: Number(data.get('maxRetries')), retryDelayMinutes: Number(data.get('retryDelayMinutes')) }) })
      await refresh('Scheduler設定を保存しました。')
    } catch (error) { flash(error.message, 'error') }
  })
}

function render() {
  const [overline, heading] = labels[currentView]
  eyebrow.textContent = overline
  title.textContent = heading
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === currentView))
  if (currentView === 'hq') renderHQ()
  if (currentView === 'blogs') renderBlogs()
  if (currentView === 'content') renderContent()
  if (currentView === 'analytics') renderAnalytics()
  if (currentView === 'ai') renderAI()
  if (currentView === 'settings') renderSettings()
}

async function refresh(message = null) {
  try {
    await loadAll()
    render()
    if (message) flash(message, 'success')
  } catch (error) { flash(error.message, 'error') }
}

function parseResearchSources(value) {
  return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf('|')
    if (separator === -1) return { label: '', url: line }
    return { label: line.slice(0, separator).trim(), url: line.slice(separator + 1).trim() }
  }).filter((item) => item.url)
}

function bindBlogForm() {
  const form = document.querySelector('#blog-form')
  const connector = form.elements.connectorType
  const fields = form.querySelector('.wordpress-fields')
  connector.addEventListener('change', () => { fields.hidden = connector.value !== 'wordpress' })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    try {
      const level = Number(data.get('autonomyLevel'))
      await request('/api/blogs', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          brain: { purpose: data.get('purpose'), audience: data.get('audience'), voice: data.get('voice'), editorialPolicy: data.get('editorialPolicy'), topics: String(data.get('topics') || '').split(',').map((item) => item.trim()).filter(Boolean) },
          connector: { type: data.get('connectorType'), endpoint: data.get('endpoint'), usernameEnv: data.get('usernameEnv'), passwordEnv: data.get('passwordEnv') },
          research: { requireCitations: data.get('requireCitations') === 'true', sources: parseResearchSources(data.get('researchSources')) },
          analytics: {
            searchConsole: { siteUrl: data.get('gscSiteUrl'), accessTokenEnv: data.get('gscTokenEnv') },
            ga4: { propertyId: data.get('ga4PropertyId'), accessTokenEnv: data.get('ga4TokenEnv') },
            http: { endpoint: data.get('metricsEndpoint'), bearerTokenEnv: data.get('metricsTokenEnv') },
          },
          autonomy: { level, allowCreate: true, allowUpdate: true, allowPublish: level >= 4 },
        }),
      })
      await refresh('ブログを接続し、Blog Brainを作成しました。')
    } catch (error) { flash(error.message, 'error') }
  })
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view]')
  if (nav) { currentView = nav.dataset.view; render(); return }
  const runBlog = event.target.closest('[data-run-blog]')
  if (runBlog) {
    try {
      flash('AI運用サイクルを実行しています…')
      await request('/api/workflows/run', { method: 'POST', body: JSON.stringify({ blogId: runBlog.dataset.runBlog }) })
      await refresh('ブログの運用サイクルが完了しました。')
    } catch (error) { flash(error.message, 'error') }
    return
  }
  const testBlog = event.target.closest('[data-test-blog]')
  if (testBlog) {
    try {
      const result = await request(`/api/blogs/${encodeURIComponent(testBlog.dataset.testBlog)}/test-connection`, { method: 'POST', body: '{}' })
      const warnings = result.metrics?.warnings?.length || 0
      flash(`接続OK: ${result.connector} / ${result.samplePosts}件${warnings ? ` / Analytics警告 ${warnings}` : ''}`, 'success')
    } catch (error) { flash(error.message, 'error') }
    return
  }
  const approve = event.target.closest('[data-approve]')
  if (approve) {
    try {
      await request(`/api/approvals/${encodeURIComponent(approve.dataset.approve)}/resolve`, { method: 'POST', body: JSON.stringify({ approved: true }) })
      await refresh('承認を反映しました。')
    } catch (error) { flash(error.message, 'error') }
  }
})

document.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-autonomy]')
  if (!select) return
  const level = Number(select.value)
  try {
    await request(`/api/blogs/${encodeURIComponent(select.dataset.autonomy)}`, { method: 'PATCH', body: JSON.stringify({ autonomy: { level, allowPublish: level >= 4 } }) })
    await refresh(`Autonomy Levelを${level}へ変更しました。`)
  } catch (error) { flash(error.message, 'error') }
})

document.querySelector('#refresh-button').addEventListener('click', () => refresh('最新状態へ更新しました。'))
cycleButton.addEventListener('click', async () => {
  try {
    flash('Portfolio Brainの優先順位で全ブログを運用しています…')
    await request('/api/workflows/run', { method: 'POST', body: '{}' })
    await refresh('Portfolio運用サイクルが完了しました。')
  } catch (error) { flash(error.message, 'error') }
})
pauseButton.addEventListener('click', async () => {
  try {
    const paused = Boolean(cache.hq?.system?.paused)
    await request(paused ? '/api/system/resume' : '/api/system/pause', { method: 'POST', body: '{}' })
    await refresh(paused ? 'AI自動運用を再開しました。' : 'すべてのAI自動運用を停止しました。')
  } catch (error) { flash(error.message, 'error') }
})

await refresh()
