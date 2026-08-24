import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.vite'])

// root 配下を再帰的に走査し、条件に合うファイルの絶対パス一覧を返す。
// 外部の glob パッケージを使わないための最小限の自前実装。
export function walkFiles(root, { extensions, excludeDirs = DEFAULT_EXCLUDE_DIRS } = {}) {
  const results = []
  const stack = [root]

  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (excludeDirs.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(full)
      }
    }
  }
  return results
}
