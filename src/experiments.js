// @feature F-011
import { createId, nowIso } from './store.js'

const METRIC_PRIORITY = ['clicks', 'views', 'sessions', 'impressions', 'users', 'published', 'posts']

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function selectExperimentMetric(snapshot = {}) {
  for (const key of METRIC_PRIORITY) {
    if (finite(snapshot[key])) return { key, value: snapshot[key] }
  }
  return { key: 'posts', value: Number(snapshot.posts || 0) }
}

function deltaPct(baseline, current) {
  if (!finite(baseline) || !finite(current)) return null
  if (baseline === 0) return current === 0 ? 0 : 100
  return ((current - baseline) / Math.abs(baseline)) * 100
}

export async function startExperiment(store, { blog, decision, snapshot, ideaId = null, articleId = null }) {
  if (!['CREATE', 'UPDATE'].includes(decision?.action)) return null
  const metric = selectExperimentMetric(snapshot)
  const experiment = {
    id: createId('experiment'),
    blogId: blog.id,
    ideaId,
    articleId,
    action: decision.action,
    hypothesis: decision.rationale || `${decision.action}が主要指標を改善するか検証する。`,
    targetMetric: metric.key,
    baselineValue: metric.value,
    latestValue: metric.value,
    deltaPct: 0,
    observations: 0,
    status: 'running',
    result: null,
    confidence: 0,
    createdAt: nowIso(),
    completedAt: null,
  }
  await store.mutate((state) => state.experiments.unshift(experiment))
  return experiment
}

export async function evaluateExperiments(store, blogId, snapshot) {
  const completed = []
  const updated = []
  await store.mutate((state) => {
    const experiments = state.experiments.filter((item) => item.blogId === blogId && item.status === 'running')
    for (const experiment of experiments) {
      const current = Number(snapshot[experiment.targetMetric])
      if (!Number.isFinite(current)) continue

      experiment.latestValue = current
      experiment.deltaPct = deltaPct(experiment.baselineValue, current)
      experiment.observations = Number(experiment.observations || 0) + 1
      experiment.lastObservedAt = nowIso()

      const enoughEvidence = experiment.observations >= 3
      const forcedConclusion = experiment.observations >= 5
      if (enoughEvidence && experiment.deltaPct >= 5) {
        experiment.status = 'completed'
        experiment.result = 'positive'
      } else if (enoughEvidence && experiment.deltaPct <= -5) {
        experiment.status = 'completed'
        experiment.result = 'negative'
      } else if (forcedConclusion) {
        experiment.status = 'completed'
        experiment.result = 'inconclusive'
      }

      experiment.confidence = Math.min(1, experiment.observations / 5)
      updated.push(structuredClone(experiment))

      if (experiment.status === 'completed') {
        experiment.completedAt = nowIso()
        const memory = {
          id: createId('memory'),
          scope: 'blog',
          blogId,
          type: 'experiment-learning',
          createdAt: nowIso(),
          confidence: experiment.confidence,
          text: `${experiment.action}「${experiment.hypothesis}」は ${experiment.targetMetric} が ${Number(experiment.deltaPct || 0).toFixed(1)}% 変化し、結果は ${experiment.result}。`,
          sourceExperimentId: experiment.id,
        }
        state.memories.unshift(memory)
        state.memories = state.memories.slice(0, 2000)
        completed.push(structuredClone(experiment))
      }
    }
  })
  return { updated, completed }
}

export function recentLearnings(state, blogId, limit = 8) {
  return state.memories
    .filter((item) => item.blogId === blogId && item.type === 'experiment-learning')
    .slice(0, limit)
    .map((item) => ({ text: item.text, confidence: item.confidence }))
}
