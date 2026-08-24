import { execFileSync } from 'node:child_process'

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

const DEFAULT_BRANCH_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']

// PHASE.md の書き換えや依存の追加が、HEAD の直前コミットではなく
// 同じブランチ内の別コミットに分散されているケースを見逃さないため、
// 明示的な base 指定が無ければ「デフォルトブランチとのマージベース」を
// 優先的に使う。1コミットしかない・デフォルトブランチが見つからない
// （fixtureやスタンドアロンリポジトリ）場合は HEAD~1 にフォールバックする。
//
// 現在のブランチ自体がデフォルトブランチである場合（guard.yml の
// `push: branches: [main]` トリガーで main に直接いる場合など）、
// merge-base(main, HEAD) は HEAD 自身に収束し、diffが常に空になって
// phase-not-bundled / no-new-deps が事実上無効化されてしまう。
// そのようなcandidateはスキップし、次の候補（最終的にはHEAD~1）へ進む。
export function resolveDefaultBase(root) {
  let head = null
  try {
    head = git(['rev-parse', 'HEAD'], root)
  } catch {
    head = null
  }

  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    let base
    try {
      base = git(['merge-base', candidate, 'HEAD'], root)
    } catch {
      continue
    }
    if (head !== null && base === head) continue
    return base
  }
  return 'HEAD~1'
}
