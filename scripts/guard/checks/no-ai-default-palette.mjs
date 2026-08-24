import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCssCustomProperties, isPlaceholder, hexToHsl, parseLength } from '../lib/css-tokens.mjs'

// craft/situations/traps.md C-050: 生成AIが既定で着地しやすい3パターンを検出する。
// いずれも tokens.css が実値で埋まっていて初めて判定可能なため、プレースホルダの
// うちは何も判定しない（誤検知よりも「判定不能」の方が安全）。
// 色の一致はあくまでヒューリスティクスであり、C-050 に挙げられた具体例の色域に
// 寄せてある。ブリーフが意図して選んだ配色を誤って弾く可能性はゼロではないため、
// 一致した場合は「差し戻し」ではなく「C-050 に照らして確認せよ」という位置づけで読むこと。

function inRange(value, min, max) {
  return value !== null && value >= min && value <= max
}

function isCreamBg(hsl) {
  return hsl && inRange(hsl.h, 20, 60) && inRange(hsl.s, 15, 45) && inRange(hsl.l, 85, 97)
}

function isTerracottaAccent(hsl) {
  return hsl && inRange(hsl.h, 5, 35) && inRange(hsl.s, 35, 80) && inRange(hsl.l, 30, 60)
}

function isSerifFont(value) {
  return !!value && /serif/i.test(value) && !/sans/i.test(value)
}

function isNearBlackBg(hsl) {
  return hsl && hsl.l < 15 && hsl.s < 15
}

function isAcidAccent(hsl) {
  if (!hsl || hsl.s < 70 || hsl.l < 35 || hsl.l > 65) return false
  const isGreen = inRange(hsl.h, 80, 160)
  const isVermillion = inRange(hsl.h, 0, 15) || inRange(hsl.h, 345, 360)
  return isGreen || isVermillion
}

export function run({ root }) {
  const tokensPath = join(root, 'docs/04-design/tokens.css')
  if (!existsSync(tokensPath)) {
    return { ok: false, messages: [`tokens.css が見つかりません: ${tokensPath}`] }
  }

  const props = parseCssCustomProperties(readFileSync(tokensPath, 'utf8'))
  const relevant = ['bg', 'accent', 'ff-display', 'radius-s', 'radius-m']
  if (relevant.every((k) => isPlaceholder(props[k]))) {
    return { ok: true, messages: ['tokens.css はまだプレースホルダのため判定対象外'] }
  }

  const bgHsl = isPlaceholder(props.bg) ? null : hexToHsl(props.bg)
  const accentHsl = isPlaceholder(props.accent) ? null : hexToHsl(props.accent)
  const messages = []
  let ok = true

  if (isCreamBg(bgHsl) && isTerracottaAccent(accentHsl) && isSerifFont(props['ff-display'])) {
    ok = false
    messages.push(
      'パターン1（クリーム地 + セリフ見出し + テラコッタ系アクセント）に一致します。' +
        'craft/situations/traps.md の C-050 を確認し、ブリーフが明示的に指定したものか確かめてください',
    )
  }

  if (isNearBlackBg(bgHsl) && isAcidAccent(accentHsl)) {
    ok = false
    messages.push(
      'パターン2（ほぼ黒の地 + アシッドグリーン/朱のアクセント）に一致します。' +
        'craft/situations/traps.md の C-050 を確認し、ブリーフが明示的に指定したものか確かめてください',
    )
  }

  const radiusS = isPlaceholder(props['radius-s']) ? null : parseLength(props['radius-s'])
  const radiusM = isPlaceholder(props['radius-m']) ? null : parseLength(props['radius-m'])
  if (radiusS === 0 && radiusM === 0) {
    ok = false
    messages.push(
      'パターン3（角丸ゼロ）に一致する可能性があります。ヘアラインの罫・新聞的多段組と' +
        '併用していないか、craft/situations/traps.md の C-050 を確認してください',
    )
  }

  if (ok) messages.push('生成AI頻出の既定パターンとの一致は検出されませんでした')
  return { ok, messages }
}
