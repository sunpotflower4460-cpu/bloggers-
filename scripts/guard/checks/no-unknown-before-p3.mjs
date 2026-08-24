import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// AGENTS.md フェーズ表の注記: 「P1にUNKNOWNまたは未回答が1件でも残っている場合、P3に進んではならない」
// PHASE.md が P3/P4 のとき、ANSWERS.md に UNKNOWN や未回答が残っていないかを検証する。
const GATED_PHASES = new Set(['P3', 'P4'])

export function run({ root }) {
  const phasePath = join(root, 'PHASE.md')
  if (!existsSync(phasePath)) {
    return { ok: false, messages: [`PHASE.md が見つかりません: ${phasePath}`] }
  }
  const phase = readFileSync(phasePath, 'utf8').split('\n')[0].trim()

  if (!GATED_PHASES.has(phase)) {
    return { ok: true, messages: [`現在のフェーズは ${phase || '(空)'}。P3/P4 未到達のためスキップ`] }
  }

  const answersPath = join(root, 'docs/01-intake/ANSWERS.md')
  if (!existsSync(answersPath)) {
    return { ok: false, messages: [`ANSWERS.md が見つかりません: ${answersPath}`] }
  }

  const content = readFileSync(answersPath, 'utf8')
  const entries = content.split(/^### /m).slice(1)

  if (entries.length === 0) {
    return { ok: false, messages: [`フェーズ ${phase} だが ANSWERS.md に質問エントリがありません`] }
  }

  const messages = []
  let ok = true

  for (const entry of entries) {
    const id = entry.split('\n')[0].trim()
    // \s* は改行にもマッチするため、値が空欄の行では次の行の内容まで
    // 誤って取り込んでしまう。[ \t]* に限定して同じ行内だけを見る。
    const confidence = entry.match(/確度[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''
    const answer = entry.match(/回答（原文ママ）[:：][ \t]*(.*)/)?.[1]?.trim() ?? ''

    if (confidence === 'UNKNOWN' || confidence === '') {
      ok = false
      messages.push(`${id}: 確度が UNKNOWN または未設定です`)
    }
    if (answer === '') {
      ok = false
      messages.push(`${id}: 回答（原文ママ）が未記入です`)
    }
  }

  if (ok) messages.push(`フェーズ ${phase}: ANSWERS.md に UNKNOWN・未回答は残っていません`)
  return { ok, messages }
}
