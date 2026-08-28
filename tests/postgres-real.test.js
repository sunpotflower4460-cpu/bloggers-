import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { addBlog, setPaused, updateBlog } from '../src/orchestrator.js'
import { createConnector } from '../src/connectors.js'
import { configureScheduler } from '../src/scheduler.js'
import { startExperiment, evaluateExperiments } from '../src/experiments.js'
import { createStore } from '../src/storage.js'

const DATABASE_URL = String(process.env.BLOGGERS_REAL_POSTGRES_URL || '').trim()

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite SQL parameter')
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return `'${String(value).replaceAll("'", "''")}'`
}

function bind(sql, params = []) {
  let text = String(sql)
  for (let index = params.length; index >= 1; index -= 1) {
    text = text.replace(new RegExp(`\\$${index}(?!\\d)`, 'g'), sqlLiteral(params[index - 1]))
  }
  return text
}

function parseCsv(text) {
  const input = String(text || '').trimEnd()
  if (!input) return []
  const records = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''))
      records.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  row.push(field.replace(/\r$/, ''))
  records.push(row)
  if (records.length < 2) return []
  const headers = records[0]
  return records.slice(1).filter((item) => item.some((value) => value !== '')).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}

class PsqlPool {
  constructor(url) {
    this.url = url
  }

  async query(sql, params = []) {
    const statement = String(sql).trim()
    if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] }
    const result = spawnSync('psql', [
      this.url,
      '--no-psqlrc',
      '--csv',
      '--quiet',
      '-P', 'footer=off',
      '-v', 'ON_ERROR_STOP=1',
      '-c', bind(sql, params),
    ], { encoding: 'utf8', env: { ...process.env, PGCONNECT_TIMEOUT: '5' } })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `psql exited ${result.status}`).trim())
    return { rows: parseCsv(result.stdout) }
  }

  async connect() {
    return { query: this.query.bind(this), release() {} }
  }
}

async function dropFoundationTables(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS
      bloggers_system_settings,
      bloggers_blogs,
      bloggers_memories,
      bloggers_experiments,
      bloggers_approvals,
      bloggers_articles,
      bloggers_ideas,
      bloggers_workflows,
      bloggers_ai_usage,
      bloggers_activities,
      bloggers_analytics,
      bloggers_operation_leases,
      bloggers_jobs,
      bloggers_state
    CASCADE
  `)
}

test('real PostgreSQL accepts the layered store SQL and round-trips core domains', { skip: !DATABASE_URL }, async () => {
  const pool = new PsqlPool(DATABASE_URL)
  await dropFoundationTables(pool)
  try {
    const store = await createStore({
      env: { ...process.env, BLOGGERS_STORAGE_DRIVER: 'postgres' },
      postgresPool: pool,
    })

    const blog = await addBlog(store, {
      name: 'Integration Blog',
      connector: { type: 'memory' },
      brain: { purpose: 'real postgres smoke', topics: ['integration'] },
      autonomy: { level: 2, allowCreate: true, allowUpdate: true, allowPublish: false },
    })
    await updateBlog(store, blog.id, { brain: { voice: 'clear' } })
    await configureScheduler(store, { enabled: true, intervalMinutes: 30, maxRetries: 2, retryDelayMinutes: 5 })
    await setPaused(store, true)
    await setPaused(store, false)

    const stateAfterBlog = await store.read()
    const liveBlog = stateAfterBlog.blogs.find((item) => item.id === blog.id)
    assert.equal(liveBlog.brain.voice, 'clear')
    assert.equal(stateAfterBlog.system.scheduler.enabled, true)
    assert.equal(stateAfterBlog.system.scheduler.intervalMinutes, 30)
    assert.equal(stateAfterBlog.system.paused, false)

    const connector = createConnector({ blog: liveBlog, store })
    const article = { id: 'article-integration', title: 'Integration draft', body: 'body' }
    const first = await connector.createDraft(article)
    const second = await connector.createDraft(article)
    assert.equal(second.id, first.id)

    const experiment = await startExperiment(store, {
      blog: liveBlog,
      decision: { action: 'CREATE', rationale: 'integration learning' },
      snapshot: { clicks: 10 },
      articleId: 'article-integration',
      ideaId: 'idea-integration',
    })
    assert.equal(experiment.status, 'running')
    await evaluateExperiments(store, blog.id, { clicks: 11 })
    await evaluateExperiments(store, blog.id, { clicks: 12 })
    const evaluated = await evaluateExperiments(store, blog.id, { clicks: 13 })
    assert.equal(evaluated.completed.length, 1)

    const finalState = await store.read()
    assert.equal(finalState.blogs.find((item) => item.id === blog.id).remotePosts.length, 1)
    assert.equal(finalState.experiments.find((item) => item.id === experiment.id).status, 'completed')
    assert.equal(finalState.memories.filter((item) => item.sourceExperimentId === experiment.id).length, 1)

    const normalized = await pool.query(`
      SELECT
        (SELECT count(*) FROM bloggers_blogs) AS blogs,
        (SELECT count(*) FROM bloggers_system_settings) AS system_sections,
        (SELECT count(*) FROM bloggers_experiments) AS experiments,
        (SELECT count(*) FROM bloggers_memories) AS memories
    `)
    assert.equal(Number(normalized.rows[0].blogs), 1)
    assert.equal(Number(normalized.rows[0].system_sections), 3)
    assert.equal(Number(normalized.rows[0].experiments), 1)
    assert.equal(Number(normalized.rows[0].memories), 1)
  } finally {
    await dropFoundationTables(pool)
  }
})
