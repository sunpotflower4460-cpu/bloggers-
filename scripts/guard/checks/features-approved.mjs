import { readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readTable } from '../lib/markdown-table.mjs'
import { walkFiles } from '../lib/fs-walk.mjs'
import { loadConfig } from '../lib/config.mjs'

// AGENTS.md ルール1: FEATURES.md に承認済みIDのない機能を実装しない
// 実装ファイル先頭の `@feature F-00X` タグを走査し、FEATURES.md 上で
// 「承認」状態のIDのみを参照しているかを検証する。
const FEATURE_TAG = /@feature\s+(F-\d+)/g
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']

export function run({ root }) {
  const featuresPath = join(root, 'docs/03-scope/FEATURES.md')
  if (!existsSync(featuresPath)) {
    return { ok: false, messages: [`FEATURES.md が見つかりません: ${featuresPath}`] }
  }

  const rows = readTable(featuresPath).filter((r) => r.ID?.trim())
  const allIds = new Set(rows.map((r) => r.ID.trim()))
  const approvedIds = new Set(rows.filter((r) => r['状態']?.trim() === '承認').map((r) => r.ID.trim()))

  let config
  try {
    config = loadConfig(root)
  } catch (e) {
    return { ok: false, messages: [`guard.config.json の読み込みに失敗しました: ${e.message}`] }
  }
  const sourceRoot = join(root, config.sourceRoot)
  const files = existsSync(sourceRoot) ? walkFiles(sourceRoot, { extensions: SOURCE_EXTENSIONS }) : []

  const messages = []
  let ok = true

  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    for (const [, id] of content.matchAll(FEATURE_TAG)) {
      if (!allIds.has(id)) {
        ok = false
        messages.push(`${relative(root, file)}: @feature ${id} は FEATURES.md に存在しません`)
      } else if (!approvedIds.has(id)) {
        ok = false
        messages.push(`${relative(root, file)}: @feature ${id} は FEATURES.md で「承認」状態ではありません`)
      }
    }
  }

  if (ok) messages.push('全ての @feature タグが承認済みIDを参照しています')
  return { ok, messages }
}
