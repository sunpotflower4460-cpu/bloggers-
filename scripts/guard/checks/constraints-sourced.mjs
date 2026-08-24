import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readTable } from '../lib/markdown-table.mjs'

// AGENTS.md ルール2: CONSTRAINTS.md に出典(Q-ID)のない制約を追加しない
// 「制約」欄が埋まっているのに「出典(Q-ID)」欄が空の行を検出する。
export function run({ root }) {
  const constraintsPath = join(root, 'docs/02-decisions/CONSTRAINTS.md')
  if (!existsSync(constraintsPath)) {
    return { ok: false, messages: [`CONSTRAINTS.md が見つかりません: ${constraintsPath}`] }
  }

  const rows = readTable(constraintsPath).filter((r) => r['制約']?.trim())
  const messages = []
  let ok = true

  for (const row of rows) {
    const source = row['出典(Q-ID)']?.trim() ?? row['出典']?.trim()
    if (!source) {
      ok = false
      messages.push(`出典のない制約: ${row.ID || '(ID未設定)'} 「${row['制約']}」`)
    }
  }

  if (ok) messages.push('全ての制約に出典(Q-ID)があります')
  return { ok, messages }
}
