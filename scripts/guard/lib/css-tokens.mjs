// tokens.css から `--name: value;` の対応表を取り出す最小限のパーサー。
// フルCSSパーサーは不要（tokens.css は :root 直下にカスタムプロパティが並ぶだけの単純な構造）。

export function parseCssCustomProperties(cssText) {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
  const props = {}
  const regex = /--([a-zA-Z0-9-]+)\s*:\s*([^;]*);/g
  let match
  while ((match = regex.exec(withoutComments))) {
    props[match[1].trim()] = match[2].trim()
  }
  return props
}

// プレースホルダ（値がコメントのみ、またはコメント除去後に空）かどうか。
export function isPlaceholder(value) {
  return !value || value.trim() === ''
}

export function hexToHsl(hex) {
  const clean = hex.replace('#', '').trim()
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null

  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min

  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r:
        h = ((g - b) / d) % 6
        break
      case g:
        h = (b - r) / d + 2
        break
      default:
        h = (r - g) / d + 4
    }
    h *= 60
    if (h < 0) h += 360
  }

  return { h, s: s * 100, l: l * 100 }
}

export function parseLength(value) {
  const match = value?.trim().match(/^(-?[\d.]+)(px|rem|em)?$/)
  if (!match) return null
  const num = parseFloat(match[1])
  if (!match[2] || match[2] === 'px') return num
  if (match[2] === 'rem' || match[2] === 'em') return num * 16 // 大まかな px 換算
  return num
}
