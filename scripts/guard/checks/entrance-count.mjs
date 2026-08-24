import { existsSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { readTable } from '../lib/markdown-table.mjs'
import { loadConfig } from '../lib/config.mjs'
import { walkFiles } from '../lib/fs-walk.mjs'

// AGENTS.md ルール6: 入口（画面・タブ・設定項目）を承認なしに増やさない
//
// 検出は2種類の手がかりを併用する:
//   1. <sourceRoot>/<entranceDirs[i]> 直下のディレクトリ（既定: src/screens, src/pages, src/routes）
//   2. sourceRoot 配下のどこにあっても、Page/Screen/Route/View 命名規則に沿うファイル名
// ディレクトリ規約だけに頼ると、単に別のディレクトリ名を使うだけで検出を回避できてしまう。
// ファイル名規約を併用することで、その回避コストを上げる（それでも命名規則そのものを
// 網羅できるわけではなく、あくまで検出範囲を広げる措置に過ぎない）。
// 1のディレクトリ配下にあるファイルは2として二重にカウントしない。
const ENTRANCE_FILENAME_PATTERN = /^[A-Z][A-Za-z0-9]*(Page|Screen|Route|View)\.(tsx|ts|jsx|js|vue|svelte)$/
const CODE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte']

function listEntranceDirs(root, config) {
  const dirs = []
  for (const dir of config.entranceDirs) {
    const full = join(root, config.sourceRoot, dir)
    if (!existsSync(full)) continue
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(full, entry.name))
    }
  }
  return dirs
}

function isInsideAny(filePath, dirPaths) {
  return dirPaths.some((d) => filePath === d || filePath.startsWith(d + sep))
}

function countEntranceUnits(root, config) {
  const dirs = listEntranceDirs(root, config)
  const sourceRoot = join(root, config.sourceRoot)

  let patternFileCount = 0
  if (existsSync(sourceRoot)) {
    for (const file of walkFiles(sourceRoot, { extensions: CODE_EXTENSIONS })) {
      const base = file.split(sep).pop()
      if (!ENTRANCE_FILENAME_PATTERN.test(base)) continue
      if (isInsideAny(file, dirs)) continue
      patternFileCount++
    }
  }

  return dirs.length + patternFileCount
}

export function run({ root }) {
  const featuresPath = join(root, 'docs/03-scope/FEATURES.md')
  if (!existsSync(featuresPath)) {
    return { ok: false, messages: [`FEATURES.md が見つかりません: ${featuresPath}`] }
  }

  const rows = readTable(featuresPath).filter((r) => r.ID?.trim())
  const approvedWithEntrance = rows.filter((r) => {
    if (r['状態']?.trim() !== '承認') return false
    // 部分一致だと「有効化前のため未定」のような否定的な文脈の中の
    // 「有」まで拾ってしまう。列の値そのものが「あり」または「有」で
    // あることを要求する（前後の空白は許容）。
    const value = (r['入口の有無'] ?? '').trim()
    return value === 'あり' || value === '有'
  }).length

  let config
  try {
    config = loadConfig(root)
  } catch (e) {
    return { ok: false, messages: [`guard.config.json の読み込みに失敗しました: ${e.message}`] }
  }
  const actualEntrances = countEntranceUnits(root, config)
  const ok = actualEntrances <= approvedWithEntrance
  const messages = [
    `承認済みかつ入口ありの機能: ${approvedWithEntrance}件 / 実際の入口: ${actualEntrances}件` +
      '（ディレクトリ規約 + Page/Screen/Route/View 命名規則）',
  ]
  if (!ok) {
    messages.push('実際の入口数が承認された入口数を超えています。FEATURES.md の承認状況と突合してください')
  }
  return { ok, messages }
}
