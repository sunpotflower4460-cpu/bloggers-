#!/usr/bin/env node
import { resolve } from 'node:path'
import { run as featuresApproved } from './checks/features-approved.mjs'
import { run as constraintsSourced } from './checks/constraints-sourced.mjs'
import { run as tokensHardcoded } from './checks/tokens-hardcoded.mjs'
import { run as entranceCount } from './checks/entrance-count.mjs'
import { run as phaseNotBundled } from './checks/phase-not-bundled.mjs'
import { run as noUnknownBeforeP3 } from './checks/no-unknown-before-p3.mjs'
import { run as noNewDeps } from './checks/no-new-deps.mjs'
import { run as noAiDefaultPalette } from './checks/no-ai-default-palette.mjs'
import { run as craftFormat } from './checks/craft-format.mjs'

// features-approved / constraints-sourced / tokens-hardcoded / entrance-count / phase-not-bundled は
// AGENTS.md の6条ルールに対応する（「ユーザー回答を原文ママで記録する」ルール4だけは、
// 参照できる原文が存在しないため機械的に検証できず対象外）。
// no-unknown-before-p3 / no-new-deps は、6条とは別にAGENTS.md本文（フェーズ表の注記、
// 「5. 実装のルール」）で明言されている規範に対応する。
// no-ai-default-palette / craft-format は craft/situations/traps.md（C-050）と
// HOW_TO_USE.md の趣旨を、tokens.css が実値で埋まった段階・craft/ 自体が
// 将来拡張された段階でも機械的に守らせるための追加チェック。
export const CHECKS = [
  { name: 'features-approved', run: featuresApproved },
  { name: 'constraints-sourced', run: constraintsSourced },
  { name: 'tokens-hardcoded', run: tokensHardcoded },
  { name: 'entrance-count', run: entranceCount },
  { name: 'phase-not-bundled', run: phaseNotBundled },
  { name: 'no-unknown-before-p3', run: noUnknownBeforeP3 },
  { name: 'no-new-deps', run: noNewDeps },
  { name: 'no-ai-default-palette', run: noAiDefaultPalette },
  { name: 'craft-format', run: craftFormat },
]

// 個々のチェックが例外を投げると、他の全チェックの結果ごと `npm run guard` の
// プロセス全体が生のスタックトレースで落ちてしまう（実際に phase-not-bundled で
// 発生した：PHASE.md がdiff範囲内で削除されているとき、想定していない
// `git show HEAD:PHASE.md` の失敗がそのまま伝播していた）。
// 各チェックの内部で個別に握り潰すのではなく、ここで一括して受け止め、
// 1件の想定外の失敗が他のチェックの実行や結果表示を妨げないようにする。
export function runAll(opts) {
  return CHECKS.map(({ name, run }) => {
    try {
      return { name, ...run(opts) }
    } catch (e) {
      return { name, ok: false, messages: [`予期しないエラーで検査を完了できませんでした: ${e.message}`] }
    }
  })
}

function parseArgs(argv) {
  const args = { root: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = resolve(argv[++i])
    if (argv[i] === '--base') args.base = argv[++i]
  }
  return args
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const results = runAll(opts)

  let allOk = true
  for (const { name, ok, messages } of results) {
    console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${name}`)
    for (const m of messages) console.log(`  ${m}`)
    if (!ok) allOk = false
  }
  console.log(`\n${allOk ? '✓ 全チェック通過' : '✗ 違反があります'}`)
  process.exit(allOk ? 0 : 1)
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`
if (isMain) main()
