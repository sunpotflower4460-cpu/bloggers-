#!/usr/bin/env node
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runAll } from './index.mjs'
import { resolveDefaultBase } from './lib/git-base.mjs'

// guard 自身の回帰テスト。
// プロジェクト本体の現在値（ANSWERS.md や tokens.css）には依存させず、
// fixtures / inline fixture だけで「検出できること」を検証する。
const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')
const tempDirs = []

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function setupTempProject(fixtureDir) {
  const root = mkdtempSync(join(tmpdir(), 'guard-selftest-'))
  tempDirs.push(root)
  cpSync(fixtureDir, root, { recursive: true })
  git(['init', '-q'], root)
  git(['config', 'user.email', 'selftest@example.com'], root)
  git(['config', 'user.name', 'guard-selftest'], root)
  git(['add', '-A'], root)
  git(['commit', '-q', '-m', 'initial'], root)
  return root
}

function commit(root, message) {
  git(['add', '-A'], root)
  git(['commit', '-q', '-m', message], root)
}

function checkResult(root, checkName, base) {
  return runAll({ root, base }).find((result) => result.name === checkName)
}

const cases = [
  {
    name: 'pass fixture: 全チェック通過',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      return runAll({ root }).every((result) => result.ok)
    },
  },
  {
    name: 'fail/features-approved: 未承認featureを検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/features-approved'))
      return checkResult(root, 'features-approved').ok === false
    },
  },
  {
    name: 'fail/constraints-sourced: 出典なし制約を検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/constraints-sourced'))
      return checkResult(root, 'constraints-sourced').ok === false
    },
  },
  {
    name: 'fail/tokens-hardcoded: 色のハードコードを検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/tokens-hardcoded'))
      return checkResult(root, 'tokens-hardcoded').ok === false
    },
  },
  {
    name: 'fail/entrance-count: 未承認入口増加を検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/entrance-count'))
      return checkResult(root, 'entrance-count').ok === false
    },
  },
  {
    name: 'phase-not-bundled: PHASEと実装の同時変更を検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'PHASE.md'), 'P4\n\nこのファイルはユーザーのみが更新する。\n')
      writeFileSync(
        join(root, 'src/screens/login/index.tsx'),
        '// @feature F-001\nexport default function Login() { return "updated" }\n',
      )
      commit(root, 'bundle phase with implementation')
      return checkResult(root, 'phase-not-bundled', 'HEAD~1').ok === false
    },
  },
  {
    name: 'phase-not-bundled: PHASE単独変更は許可する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'PHASE.md'), 'P4\n\nこのファイルはユーザーのみが更新する。\n')
      commit(root, 'phase only')
      return checkResult(root, 'phase-not-bundled', 'HEAD~1').ok === true
    },
  },
  {
    name: 'no-unknown-before-p3: P3の未回答を検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/no-unknown-before-p3'))
      return checkResult(root, 'no-unknown-before-p3').ok === false
    },
  },
  {
    name: 'no-unknown-before-p3: P1では未回答を許可する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/no-unknown-before-p3'))
      writeFileSync(join(root, 'PHASE.md'), 'P1\n\nこのファイルはユーザーのみが更新する。\n')
      commit(root, 'still in P1')
      return checkResult(root, 'no-unknown-before-p3').ok === true
    },
  },
  {
    name: '回帰防止: ANSWERSテンプレートの見本を実回答として数えない',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/no-unknown-before-p3'))
      const shippedPlaceholder = [
        '# ANSWERS.md',
        '',
        '<!-- 下のインデントされた例は実データではない -->',
        '',
        '    ### Q-001',
        '    - 質問:',
        '    - 回答（原文ママ）:',
        '    - GPTの解釈:',
        '    - 確度: 確定 / 推定 / UNKNOWN',
        '',
      ].join('\n')
      writeFileSync(join(root, 'docs/01-intake/ANSWERS.md'), shippedPlaceholder)
      commit(root, 'use shipped placeholder answers')
      const result = checkResult(root, 'no-unknown-before-p3')
      return result.ok === false && !result.messages.some((message) => message.includes('Q-001'))
    },
  },
  {
    name: 'no-new-deps: 新規依存を検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      commit(root, 'add dependency')
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: 'no-new-deps: 依存追加なしは許可する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }, null, 2))
      commit(root, 'no dependency change')
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === true
    },
  },
  {
    name: 'guard.config.json: sourceRoot/entranceDirs上書きを反映する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'config-override'))
      return checkResult(root, 'entrance-count').ok === false
    },
  },
  {
    name: '入口命名規則: Screen/Page命名も検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/entrance-count-filename-pattern'))
      return checkResult(root, 'entrance-count').ok === false
    },
  },
  {
    name: 'no-new-deps: package.json新規作成時の依存も検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/features-approved'))
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }, null, 2),
      )
      commit(root, 'add package with dependency')
      return checkResult(root, 'no-new-deps', 'HEAD~1').ok === false
    },
  },
  {
    name: 'no-ai-default-palette: cream patternを検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/no-ai-default-palette-cream'))
      return checkResult(root, 'no-ai-default-palette').ok === false
    },
  },
  {
    name: 'no-ai-default-palette: dark patternを検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/no-ai-default-palette-dark'))
      return checkResult(root, 'no-ai-default-palette').ok === false
    },
  },
  {
    name: 'no-ai-default-palette: 角丸ゼロを検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      const cssPath = join(root, 'docs/04-design/tokens.css')
      const css = readFileSync(cssPath, 'utf8')
        .replace(/--radius-s:[^;]+;/, '--radius-s: 0px;')
        .replace(/--radius-m:[^;]+;/, '--radius-m: 0px;')
      writeFileSync(cssPath, css)
      commit(root, 'zero radius')
      return checkResult(root, 'no-ai-default-palette').ok === false
    },
  },
  {
    name: 'no-ai-default-palette: プレースホルダはスキップする',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'docs/04-design/tokens.css'),
        ':root {\n  --bg: /* プロジェクトごとに定義 */;\n  --accent: /* プロジェクトごとに定義 */;\n  --ff-display: /* プロジェクトごとに定義 */;\n  --radius-s: /* プロジェクトごとに定義 */;\n  --radius-m: /* プロジェクトごとに定義 */;\n}\n',
      )
      return checkResult(root, 'no-ai-default-palette').ok === true
    },
  },
  {
    name: 'craft-format: 見出し欠落と短すぎる理由を検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'fail/craft-format'))
      const result = checkResult(root, 'craft-format')
      return (
        result.ok === false &&
        result.messages.some((message) => message.includes('C-901') && message.includes('なぜ')) &&
        result.messages.some((message) => message.includes('C-902') && message.includes('短すぎ'))
      )
    },
  },
  {
    name: '回帰防止: default baseがHEAD自身に収束しない',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      mkdirSync(join(root, 'src/screens/second'), { recursive: true })
      writeFileSync(join(root, 'PHASE.md'), 'P4\n\nこのファイルはユーザーのみが更新する。\n')
      writeFileSync(
        join(root, 'src/screens/second/index.tsx'),
        '// @feature F-001\nexport default function X() { return null }\n',
      )
      commit(root, 'bundle directly on default branch')
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      const base = resolveDefaultBase(root)
      return base !== 'HEAD' && base !== head && checkResult(root, 'phase-not-bundled').ok === false
    },
  },
  {
    name: '回帰防止: 8桁hexも検出する',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      mkdirSync(join(root, 'src/screens/alpha'), { recursive: true })
      writeFileSync(
        join(root, 'src/screens/alpha/index.tsx'),
        "// @feature F-001\nexport default function X() { return <div style={{ color: '#1a2b3c4d' }} /> }\n",
      )
      commit(root, 'add 8 digit hex')
      return checkResult(root, 'tokens-hardcoded').ok === false
    },
  },
  {
    name: '回帰防止: 不正package.jsonを黙殺しない',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'package.json'), '{ "dependencies": { "left-pad": "1.0.0", } }')
      const result = checkResult(root, 'no-new-deps', 'HEAD')
      return result.ok === false && result.messages.some((message) => message.includes('不正なJSON'))
    },
  },
  {
    name: '回帰防止: 不正guard.config.jsonを黙殺しない',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(join(root, 'guard.config.json'), '{ sourceRoot: app }')
      const result = checkResult(root, 'entrance-count')
      return result.ok === false && result.messages.some((message) => message.includes('guard.config.json'))
    },
  },
  {
    name: '回帰防止: 入口判定は部分一致に反応しない',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      writeFileSync(
        join(root, 'docs/03-scope/FEATURES.md'),
        [
          '# FEATURES.md',
          '',
          '| ID | 機能名 | 状態 | 魂との関係 | 承認日 | 入口の有無 |',
          '|---|---|---|---|---|---|',
          '| F-001 | ログイン | 承認 | 中核 | 2026-01-01 | 有効化前のため未定 |',
        ].join('\n'),
      )
      const result = checkResult(root, 'entrance-count')
      return result.ok === false && result.messages[0].includes('承認済みかつ入口ありの機能: 0件')
    },
  },
  {
    name: '回帰防止: PHASE削除でもphase-not-bundledは例外を投げない',
    expect() {
      const root = setupTempProject(join(FIXTURES, 'pass'))
      const initialSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      unlinkSync(join(root, 'PHASE.md'))
      mkdirSync(join(root, 'src/screens/second'), { recursive: true })
      writeFileSync(
        join(root, 'src/screens/second/index.tsx'),
        '// @feature F-001\nexport default function X() { return null }\n',
      )
      commit(root, 'delete phase alongside implementation')
      try {
        return checkResult(root, 'phase-not-bundled', initialSha).ok === false
      } catch {
        return false
      }
    },
  },
  {
    name: '回帰防止: runAllは1チェックの例外で全体を落とさない',
    expect() {
      try {
        const results = runAll({ root: '/nonexistent-path-for-selftest-xyz' })
        return results.length === 9 && results.every((result) => typeof result.ok === 'boolean')
      } catch {
        return false
      }
    },
  },
]

let allPass = true
for (const testCase of cases) {
  let ok = false
  try {
    ok = Boolean(testCase.expect())
  } catch (error) {
    console.error(error)
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${testCase.name}`)
  if (!ok) allPass = false
}

for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 一時領域の削除失敗はテスト本体の成否に影響させない。
  }
}

console.log(allPass ? '\n✓ セルフテスト全て通過' : '\n✗ セルフテストに失敗があります')
process.exit(allPass ? 0 : 1)
