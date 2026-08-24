import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, resolveDefaultBase } from '../lib/git-base.mjs'

// AGENTS.md「5. 実装のルール」: 1PRあたり新規依存は0
// ルートの package.json の dependencies/devDependencies を base と HEAD で比較し、
// 新規に追加されたパッケージがないかを検証する。
// package.json を持たないプロジェクト（他言語スタック）ではスキップする。
//
// base を明示しない場合は、直前コミットとの比較ではなく現在のブランチと
// デフォルトブランチとのマージベースを使う。依存追加だけの小さなコミットを
// 挟んでおいて実装は別コミットにする、という分割で HEAD~1 比較はすり抜けられて
// しまうため、同じブランチ（同じPR）内の全コミットをまとめて見る。
// パース失敗を「依存0件」と区別せず返すための番兵オブジェクト。
const PARSE_FAILED = Symbol('parse-failed')

function depNames(pkgJsonText) {
  if (!pkgJsonText) return new Set()
  let pkg
  try {
    pkg = JSON.parse(pkgJsonText)
  } catch {
    return PARSE_FAILED
  }
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
}

export function run({ root, base }) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) {
    return { ok: true, messages: ['package.json が存在しないためスキップ'] }
  }
  if (!existsSync(join(root, '.git'))) {
    return { ok: true, messages: ['.git が見つからないためスキップ（Gitリポジトリ外）'] }
  }

  const resolvedBase = base ?? resolveDefaultBase(root)

  // base 参照そのものが解決できない場合（浅いクローン・最初のコミットなど）はスキップする。
  try {
    git(['rev-parse', '--verify', resolvedBase], root)
  } catch {
    return { ok: true, messages: [`比較対象 ${resolvedBase} を解決できないためスキップ`] }
  }

  // base は解決できるが、その時点で package.json 自体が存在しない場合は
  // 「依存0件だった」とみなす（依存を新規追加したまま package.json ごと
  // 追加するケースを見逃さないため、ここではスキップしない）。
  let beforeText = ''
  try {
    beforeText = git(['show', `${resolvedBase}:package.json`], root)
  } catch {
    beforeText = ''
  }

  const afterText = readFileSync(pkgPath, 'utf8')
  const after = depNames(afterText)
  if (after === PARSE_FAILED) {
    return { ok: false, messages: ['package.json が不正なJSONです。依存の追加有無を検証できません。修正してください'] }
  }

  const before = depNames(beforeText)
  const beforeSet = before === PARSE_FAILED ? new Set() : before
  const added = [...after].filter((name) => !beforeSet.has(name))

  if (added.length > 0) {
    return {
      ok: false,
      messages: ['新規の依存パッケージが追加されています（1PRあたり新規依存は0）', ...added.map((n) => `  - ${n}`)],
    }
  }
  return { ok: true, messages: ['新規の依存パッケージはありません'] }
}
