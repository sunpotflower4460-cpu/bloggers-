# Bloggers — AI Editorial Operating System

Bloggers は、**AIが複数のブログへ接続し、1つの統合HPから観測・判断・制作・公開・計測・学習を回すためのAI編集部OS**です。

単なる記事生成や一括投稿ではなく、各ブログに独立した `Blog Brain` を持たせ、ブログごとの読者・文体・目的・収益方針を混線させずに運用します。その上に `Portfolio Brain` を置き、ブログ群全体を横断して次の行動を考える構造を目指します。

## 現在の実装

Foundation版では、外部npm依存を追加せず Node.js 標準機能だけで起動できるところまで実装しています。

- Bloggers HQ 統合ダッシュボード
- 複数ブログ登録
- ブログごとの Blog Brain
- Memory / WordPress Connector
- AI Provider abstraction
- ローカルのルールベースAI（APIキーなしでも動作）
- OpenAI互換 Chat Completions API への切り替え
- 観測 → 判断 → 企画 → 下書き → 承認/公開 → 記録 の運用サイクル
- Autonomy Level 0〜5
- 公開承認キュー
- Emergency Pause / Resume
- Analyticsスナップショット基盤
- AI Activity / Workflow監査ログ
- JSON永続化
- Node標準テスト

## 起動

必要環境: Node.js 20+

```bash
npm start
```

ブラウザで次を開きます。

```text
http://localhost:3000
```

開発中は:

```bash
npm run dev
```

テスト:

```bash
npm test
npm run guard
npm run guard:selftest
```

## 最初の使い方

1. `Blogs` を開く
2. ブログ名・目的・読者・文体・主要テーマを入力する
3. 最初は `Memory / Demo` Connector で登録してもよい
4. `AI運用サイクル` を実行する
5. `Content` でAIの企画と下書きを確認する
6. `HQ` で承認待ちやPortfolio Brainの状態を見る
7. 必要なら `PAUSE ALL AI` で全自動操作を即時停止する

## WordPress接続

ブログ登録時に Connector を `WordPress` にして以下を登録します。

- WordPress URL
- WordPressユーザー名を格納する環境変数名
- Application Passwordを格納する環境変数名

例:

```bash
export WP_MUSIC_USER="editor"
export WP_MUSIC_PASSWORD="xxxx xxxx xxxx xxxx"
```

BloggersのJSONデータには資格情報そのものを保存しません。

## AI Provider

AI設定がない場合は `RuleBasedProvider` がローカルで動き、システム全体の動作を確認できます。

外部AIを使用する場合:

```bash
export BLOGGERS_AI_BASE_URL="https://provider.example/v1"
export BLOGGERS_AI_API_KEY="..."
export BLOGGERS_AI_MODEL="model-name"
```

Foundation版の外部AI Adapter は OpenAI互換の `/chat/completions` を使用します。Provider層は分離されているため、Claude / Gemini / OpenAI固有Adapterなどを中核ロジックを変更せず追加できます。

## Autonomy Level

| Level | 動作 |
|---|---|
| 0 | 観測のみ |
| 1 | AI提案のみ |
| 2 | 下書きまで自動 |
| 3 | 公開前に人間承認 |
| 4 | 許可された記事を自動公開 |
| 5 | 将来の完全自律運営用 |

削除操作はFoundation版では常に禁止しています。

## アーキテクチャ

```text
Portfolio Brain / HQ
        |
        +-- Blog Brain A
        |      +-- Observer
        |      +-- Director
        |      +-- Writer
        |      +-- Publisher
        |
        +-- Blog Brain B
        |
        +-- Blog Brain N

AI Orchestrator
        |
Connector Layer
        +-- Memory
        +-- WordPress
        +-- future: Ghost / microCMS / custom

JsonStore
        +-- blogs
        +-- ideas
        +-- articles
        +-- approvals
        +-- analytics
        +-- workflows
        +-- activities
```

主要コード:

- `src/server.js` — HTTP/API/UI配信
- `src/store.js` — 永続化
- `src/connectors.js` — CMS Connector abstraction
- `src/ai.js` — AI Provider abstraction
- `src/orchestrator.js` — 自律運用ループ / Portfolio集計 / 承認 / Emergency Brake
- `src/public/` — 統合HP

## 次の拡張

Foundationの次は、同じ境界を保ったまま以下を追加します。

- Google Search Console / GA4
- Ghost Connector
- 記事リライト・統合・内部リンク改善
- Source / citation管理とファクトチェック
- Scheduler / durable queue
- Experiment Engine
- 検索・収益データを含むPortfolio Brain
- AIモデルごとのRouting / cost governor
- マルチユーザー認証と暗号化Secrets管理
- PostgreSQLへの永続化移行

## Guardrail

このリポジトリでは、AI開発による意図しない仕様逸脱を防ぐため、`AGENTS.md` と `docs/` の台帳、GitHub Actionsのguardを残しています。

現在の実装対象は `FEATURES.md` の承認済み機能IDに紐づいています。
