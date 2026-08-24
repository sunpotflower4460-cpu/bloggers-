#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTable } from './lib/markdown-table.mjs'

// GPT がセッション開始時に状況を素早く把握するための一括表示。
// PHASE.md / SOUL.md / FEATURES.md / CONSTRAINTS.md / ANSWERS.md / BACKLOG.md を
// 個別に読みに行く代わりに、この1コマンドで要点を確認できるようにする。

function readFirstLine(path) {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8').split('\n')[0].trim()
}

function soulOneLiner(root) {
  const path = join(root, 'docs/00-soul/SOUL.md')
  if (!existsSync(path)) return null
  const content = readFileSync(path, 'utf8')
  const section = content.split('## 一文で言うと')[1]?.split('\n## ')[0] ?? ''
  const line = section
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('<!--') && !l.startsWith('（'))
  return line ?? null
}

function answersEntries(root) {
  const path = join(root, 'docs/01-intake/ANSWERS.md')
  if (!existsSync(path)) return []
  const content = readFileSync(path, 'utf8')
  return content.split(/^### /m).slice(1)
}

function main() {
  const root = process.cwd()
  const lines = []

  lines.push('=== プロジェクト状況スナップショット ===')
  lines.push('')

  const phase = readFirstLine(join(root, 'PHASE.md'))
  lines.push(`PHASE: ${phase ?? '(PHASE.md が見つかりません)'}`)

  const soul = soulOneLiner(root)
  lines.push(`SOUL: ${soul || '(未記入)'}`)

  const featuresPath = join(root, 'docs/03-scope/FEATURES.md')
  if (existsSync(featuresPath)) {
    const rows = readTable(featuresPath).filter((r) => r.ID?.trim())
    const byState = {}
    for (const row of rows) {
      const state = row['状態']?.trim() || '(未設定)'
      byState[state] = (byState[state] ?? 0) + 1
    }
    lines.push('')
    lines.push(`FEATURES.md: 計${rows.length}件`)
    for (const [state, count] of Object.entries(byState)) {
      lines.push(`  ${state}: ${count}件`)
    }
  }

  const constraintsPath = join(root, 'docs/02-decisions/CONSTRAINTS.md')
  if (existsSync(constraintsPath)) {
    const rows = readTable(constraintsPath).filter((r) => r['制約']?.trim())
    const missing = rows.filter((r) => !r['出典(Q-ID)']?.trim())
    lines.push('')
    lines.push(`CONSTRAINTS.md: 計${rows.length}件（出典なし: ${missing.length}件）`)
  }

  const entries = answersEntries(root)
  const open = entries.filter((e) => {
    // \s* は改行にもマッチするため、値が空欄の行では次の行の内容まで
    // 誤って取り込んでしまう。[ \t]* に限定して行内だけを見る。
    const confidence = e.match(/確度[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''
    const answer = e.match(/回答（原文ママ）[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''
    return confidence === 'UNKNOWN' || confidence === '' || answer === ''
  })
  lines.push('')
  lines.push(`ANSWERS.md: 計${entries.length}件（UNKNOWN・未回答: ${open.length}件）`)
  for (const e of open) {
    lines.push(`  - ${e.split('\n')[0].trim()}`)
  }

  const backlogPath = join(root, 'docs/03-scope/BACKLOG.md')
  if (existsSync(backlogPath)) {
    const rows = readTable(backlogPath).filter((r) => Object.values(r).some((v) => v?.trim()))
    lines.push('')
    lines.push(`BACKLOG.md: 計${rows.length}件`)
  }

  lines.push('')
  lines.push('次のアクション:')
  lines.push('  npm run guard          — 機械チェックを実行')
  lines.push('  npm run guard:selftest — guardチェック自体の健全性を確認')

  console.log(lines.join('\n'))
}

main()
