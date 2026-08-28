// @feature F-005
// @feature F-011
function stripFence(text) {
  return String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
}

function parseJson(text) {
  try {
    return JSON.parse(stripFence(text))
  } catch {
    return null
  }
}

export class RuleBasedProvider {
  name = 'rule-based-local'

  async decide({ blog, posts, learnings = [] }) {
    const topics = blog.brain?.topics?.filter(Boolean) ?? []
    const topic = topics[posts.length % Math.max(topics.length, 1)] ?? blog.brain?.purpose ?? blog.name
    const existingTitles = posts.map((post) => post.title?.rendered ?? post.title).filter(Boolean)
    const title = `${topic}：読者が最初に知っておきたいこと`
    const duplicate = existingTitles.some((item) => String(item).includes(topic))
    const negativeLearning = learnings.find((item) => /negative/.test(item.text || ''))
    return {
      action: duplicate || negativeLearning ? 'WAIT' : 'CREATE',
      topic,
      title,
      rationale: duplicate
        ? '同テーマの記事がすでにあるため、新規量産より既存記事の観測を優先します。'
        : negativeLearning
          ? '直近の実験で悪化シグナルがあるため、追加制作より観測を優先します。'
          : 'Blog Brainの主要テーマに未充足の入口記事があるため、下書き候補として提案します。',
      confidence: negativeLearning ? 0.62 : 0.55,
      provider: this.name,
    }
  }

  async draft({ blog, decision, learnings = [] }) {
    const audience = blog.brain?.audience || 'このテーマを知りたい読者'
    const voice = blog.brain?.voice || '明快で誠実'
    const learningNote = learnings.length > 0
      ? `\n\n## 過去の運用からの学び\n\n${learnings.slice(0, 3).map((item) => `- ${item.text}`).join('\n')}`
      : ''
    return {
      title: decision.title,
      body: [
        `# ${decision.title}`,
        '',
        `${audience}に向けて、${decision.topic}を整理します。`,
        '',
        '## まず押さえたいこと',
        '',
        `${decision.topic}は、目的と前提を分けて考えると理解しやすくなります。`,
        '',
        '## 次に確認すること',
        '',
        '- 読者が今どこで迷っているか',
        '- 一次情報や実測データで確認できることは何か',
        '- この記事の次に読むべき情報は何か',
        '',
        `文体方針: ${voice}${learningNote}`,
      ].join('\n'),
      provider: this.name,
    }
  }
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
    this.name = `openai-compatible:${model}`
  }

  async #complete(messages, { temperature = 0.3 } = {}) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, messages, temperature }),
    })
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(payload?.error?.message || `AI provider HTTP ${response.status}`)
    }
    return payload?.choices?.[0]?.message?.content ?? ''
  }

  async decide({ blog, posts, metrics, learnings = [] }) {
    const content = await this.#complete([
      {
        role: 'system',
        content: 'You are the editorial director of one blog. Return JSON only. Never optimize for article count; WAIT is valid. Prefer measured learning over intuition.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Choose the next editorial action.',
          allowedActions: ['CREATE', 'UPDATE', 'WAIT'],
          requiredKeys: ['action', 'topic', 'title', 'rationale', 'confidence'],
          blogBrain: blog.brain,
          recentLearnings: learnings,
          recentPosts: posts.slice(0, 20).map((post) => ({ id: post.id, title: post.title?.rendered ?? post.title, status: post.status })),
          metrics,
        }),
      },
    ])
    const decision = parseJson(content)
    if (!decision || !['CREATE', 'UPDATE', 'WAIT'].includes(decision.action)) {
      throw new Error('AI provider returned an invalid editorial decision')
    }
    return { ...decision, provider: this.name }
  }

  async draft({ blog, decision, learnings = [] }) {
    const content = await this.#complete([
      {
        role: 'system',
        content: 'Write a useful blog draft. Follow the supplied editorial policy and voice. Do not fabricate facts or sources. Use measured learnings only when they are relevant.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          title: decision.title,
          topic: decision.topic,
          purpose: blog.brain?.purpose,
          audience: blog.brain?.audience,
          voice: blog.brain?.voice,
          editorialPolicy: blog.brain?.editorialPolicy,
          monetization: blog.brain?.monetization,
          recentLearnings: learnings,
        }),
      },
    ], { temperature: 0.6 })
    return { title: decision.title, body: content, provider: this.name }
  }
}

export function createAIProvider() {
  const baseUrl = process.env.BLOGGERS_AI_BASE_URL
  const apiKey = process.env.BLOGGERS_AI_API_KEY
  const model = process.env.BLOGGERS_AI_MODEL
  if (baseUrl && apiKey && model) {
    return new OpenAICompatibleProvider({ baseUrl, apiKey, model })
  }
  return new RuleBasedProvider()
}
