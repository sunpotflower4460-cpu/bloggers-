import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// craft/situations/*.md の「1項目のフォーマット（厳守）」を検証する。
// 「なぜ」欄の中身が本当に説得力を持つかという意味的な質は静的には判定できないが、
// 見出しが揃っているか・空欄や極端に短い placeholder になっていないかは検証できる。
// HOW_TO_USE.md 「理由のない指示は誤適用される」の趣旨を、将来 craft/ に項目が
// 追加された場合にも機械的に守らせるための最低限のチェック。
const REQUIRED_HEADINGS = ['よくする', 'よくない', 'なぜ', '型による差', '実例']
const MIN_WHY_LENGTH = 20

function extractSection(entry, heading, nextHeadingsPattern) {
  const regex = new RegExp(`\\*\\*${heading}\\*\\*\\n([\\s\\S]*?)(?:\\n\\n${nextHeadingsPattern}|$)`)
  const match = entry.match(regex)
  return match ? match[1].trim() : null
}

export function run({ root }) {
  const situationsDir = join(root, 'craft/situations')
  if (!existsSync(situationsDir)) {
    return { ok: true, messages: ['craft/situations/ が存在しないため検査対象なし'] }
  }

  const files = readdirSync(situationsDir).filter((f) => f.endsWith('.md'))
  const messages = []
  let ok = true
  let entryCount = 0

  const anyHeadingPattern = '\\*\\*(?:' + REQUIRED_HEADINGS.join('|') + ')\\*\\*'

  for (const file of files) {
    const content = readFileSync(join(situationsDir, file), 'utf8')
    const entries = content.split(/^### /m).slice(1)

    for (const entry of entries) {
      entryCount++
      const id = entry.split('\n')[0].trim()

      for (const heading of REQUIRED_HEADINGS) {
        if (!entry.includes(`**${heading}**`)) {
          ok = false
          messages.push(`${file} ${id}: 見出し「${heading}」がありません`)
        }
      }

      const why = extractSection(entry, 'なぜ', anyHeadingPattern)
      if (why !== null && why.length < MIN_WHY_LENGTH) {
        ok = false
        messages.push(`${file} ${id}: 「なぜ」欄が短すぎます（${why.length}文字 < ${MIN_WHY_LENGTH}文字）`)
      }
    }
  }

  if (entryCount === 0) {
    return { ok: false, messages: ['craft/situations/ に項目が1件もありません'] }
  }

  if (ok) messages.push(`craft/situations/ 全${entryCount}項目のフォーマットは正常です`)
  return { ok, messages }
}
