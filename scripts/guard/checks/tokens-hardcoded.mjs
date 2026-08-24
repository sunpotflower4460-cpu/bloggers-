import { readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walkFiles } from '../lib/fs-walk.mjs'
import { loadConfig } from '../lib/config.mjs'

// AGENTS.md ルール3: tokens.css にない色・サイズ値をハードコードしない
// src/ 配下の実装ファイルから直接の hex カラーリテラルを検出する。
// docs/ や craft/ など、原則やNG例を説明する文書は対象外（tokens.css 自体も対象外）。
// CSSの有効な16進カラーは3/4/6/8桁（RGB/RGBA/RRGGBB/RRGGBBAA）。
// {3,6} という単純な範囲指定では8桁（アルファ付き）に一切マッチしない
// （\b が桁の途中でしか成立せず、6桁で打ち切られた直後も16進文字が続くため）。
// 長い桁から順に試すことで、この取りこぼしを防ぐ。
const HEX_COLOR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b/g
const SOURCE_EXTENSIONS = ['.css', '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']

export function run({ root }) {
  let config
  try {
    config = loadConfig(root)
  } catch (e) {
    return { ok: false, messages: [`guard.config.json の読み込みに失敗しました: ${e.message}`] }
  }
  const sourceRoot = join(root, config.sourceRoot)
  if (!existsSync(sourceRoot)) {
    return { ok: true, messages: [`${config.sourceRoot}/ が存在しないため検査対象なし`] }
  }

  const files = walkFiles(sourceRoot, { extensions: SOURCE_EXTENSIONS })
  const messages = []
  let ok = true

  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const matches = content.match(HEX_COLOR)
    if (matches) {
      ok = false
      messages.push(`${relative(root, file)}: ハードコードされた色 ${[...new Set(matches)].join(', ')}`)
    }
  }

  if (ok) messages.push('src/ 配下に色のハードコードはありません')
  return { ok, messages }
}
