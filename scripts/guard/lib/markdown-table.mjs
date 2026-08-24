import { readFileSync } from 'node:fs'

// 最初に現れる GFM テーブルを行オブジェクトの配列にパースする。
export function parseFirstTable(markdown) {
  const lines = markdown.split('\n')
  const tableLines = []
  let inTable = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|')) {
      inTable = true
      tableLines.push(trimmed)
    } else if (inTable) {
      break
    }
  }
  if (tableLines.length < 2) return []

  const splitRow = (line) => {
    const body = line.startsWith('|') ? line.slice(1) : line
    const trimmedBody = body.endsWith('|') ? body.slice(0, -1) : body
    return trimmedBody.split('|').map((cell) => cell.trim())
  }

  const headers = splitRow(tableLines[0])
  const dataLines = tableLines.slice(2) // 1行目=ヘッダ, 2行目=区切り線

  return dataLines.map((line) => {
    const cells = splitRow(line)
    const row = {}
    headers.forEach((header, i) => {
      row[header] = cells[i] ?? ''
    })
    return row
  })
}

export function readTable(path) {
  return parseFirstTable(readFileSync(path, 'utf8'))
}
