import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git, resolveDefaultBase } from '../lib/git-base.mjs'

// AGENTS.md ルール5: PHASE.md を自分で書き換えない
// 「誰が」変更したかは静的には判定できないため、代替の機械的シグナルとして
// 「PHASE.md が実装ファイルと同じ差分に含まれているか」を検出する。
// フェーズ移行は本来ユーザーの承認による独立した変更であるべきで、
// 実装コミットに紛れている場合はレビュー対象として警告する（誤検知はあり得る、という前提のヒューリスティクス）。
//
// base を明示しない場合は、直前コミットとの比較ではなく現在のブランチと
// デフォルトブランチとのマージベースを使う。PHASE.md だけを先に変更する
// コミットと、実装だけを行うコミットを分ければ HEAD~1 比較はすり抜けられて
// しまうため、同じブランチ（同じPR）内の全コミットをまとめて見る。
export function run({ root, base }) {
  if (!existsSync(join(root, '.git'))) {
    return { ok: true, messages: ['.git が見つからないためスキップ（Gitリポジトリ外）'] }
  }

  const resolvedBase = base ?? resolveDefaultBase(root)

  let changed
  try {
    changed = git(['diff', '--name-only', resolvedBase, 'HEAD'], root)
      .split('\n')
      .filter(Boolean)
  } catch {
    return { ok: true, messages: [`比較対象 ${resolvedBase} を解決できないためスキップ`] }
  }

  if (!changed.includes('PHASE.md')) {
    return { ok: true, messages: ['PHASE.md は変更されていません'] }
  }

  // PHASE.md が base 時点で存在しない場合（初回のブートストラップで新規作成した場合）は
  // 「書き換え」ではない。README.md の手順1「PHASE.md をP0にする」はこの操作そのものであり、
  // 正当な初期化と、値の変更（フェーズ移行）を区別する必要がある。
  let beforeValue = null
  try {
    beforeValue = git(['show', `${resolvedBase}:PHASE.md`], root).split('\n')[0].trim()
  } catch {
    beforeValue = null
  }
  if (beforeValue === null) {
    return { ok: true, messages: ['PHASE.md は base 時点で存在しないため、新規作成として扱いスキップします'] }
  }

  // base 時点には存在した PHASE.md が HEAD では削除・移動されている可能性がある
  // （diffに名前が出るのは変更・削除どちらでも同じ）。その場合 `git show HEAD:PHASE.md`
  // は失敗するため、他の git show 呼び出しと同様に握りつぶす。
  let afterValue
  try {
    afterValue = git(['show', 'HEAD:PHASE.md'], root).split('\n')[0].trim()
  } catch {
    return {
      ok: false,
      messages: [`PHASE.md が ${resolvedBase}..HEAD の間で削除または移動されています。意図した変更か確認してください`],
    }
  }
  if (beforeValue === afterValue) {
    return { ok: true, messages: [`PHASE.md の値（${afterValue}）は変わっていません`] }
  }

  const nonDocChanges = changed.filter(
    (f) => f !== 'PHASE.md' && !f.startsWith('docs/') && !f.startsWith('craft/') && !f.endsWith('.md'),
  )

  if (nonDocChanges.length > 0) {
    return {
      ok: false,
      messages: [
        `PHASE.md が ${beforeValue} → ${afterValue} へ変更され、同じブランチ内（${resolvedBase}..HEAD）で実装ファイルも変更されています。ユーザー承認によるフェーズ移行か確認してください`,
        ...nonDocChanges.map((f) => `  - ${f}`),
      ],
    }
  }

  return { ok: true, messages: ['PHASE.md の変更は実装ファイルと分離されています'] }
}
