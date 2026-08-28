# Bloggers — AI Editorial Operating System

Bloggers は、**AIが複数のブログへ接続し、1つの統合HPから観測・判断・制作・公開・計測・学習を回すためのAI編集部OS**です。

単なる記事生成や一括投稿ではなく、各ブログに独立した `Blog Brain` を持たせ、ブログごとの読者・文体・目的・収益方針を混線させずに運用します。その上に `Portfolio Brain` を置き、ブログ群全体を横断して「次にどのブログへ時間を使うか」まで判断します。

## 現在の実装

現在のFoundationは、外部npm依存を追加せず Node.js 標準機能だけで起動できます。

- Bloggers HQ 統合ダッシュボード
- 複数ブログ登録 / 独立した Blog Brain
- Memory / WordPress Connector
- AI Provider abstraction
- ローカルのルールベースAI（APIキーなしでも動作）
- OpenAI互換 Chat Completions API
- 観測 → 判断 → 企画 → 下書き → 承認/公開 → 計測 → 学習 の運用サイクル
- Portfolio Brainによるブログ横断スコアリングと実行順決定
- Autonomy Level 0〜5
- 公開承認キュー
- Emergency Pause / Resume
- CMS + Google Search Console + GA4 + Custom HTTP Metrics のAnalytics Hub
- Experiment Engine
- 実験結果から Blog Memory へ学習を昇格するLearning Engine
- 定時Autonomous Scheduler
- 失敗ブログの再試行キュー
- AI Activity / Workflow監査ログ
- JSON永続化
- 管理トークンによるAPI保護
- Node標準テスト / 構文チェック

## 起動

必要環境: Node.js 20+

```bash
npm start
```

ブラウザで次を開きます。

```text
http://localhost:3000
```

開発中:

```bash
npm run dev
```

確認:

```bash
npm run check
npm test
npm run guard
npm run guard:selftest
```

## 最初の使い方

1. `Blogs` でブログ名・目的・読者・文体・主要テーマを登録する
2. 最初は `Memory / Demo` Connector でもよい
3. 必要ならWordPressとSearch Console / GA4を接続する
4. `AI運用サイクル` を一度手動実行する
5. `Content` で企画と下書きを確認する
6. `Analytics` で観測・実験・Blog Memoryを見る
7. `Settings` で定時SchedulerをONにする
8. `HQ` でPortfolio Brainの優先順位と承認待ちを見る
9. 問題があれば `PAUSE ALL AI` で全自動操作を即停止する

## Autonomous Scheduler

`Settings` から次を設定できます。

- ON / OFF
- 実行間隔（最短15分）
- 最大リトライ回数
- リトライ間隔

Schedulerはプロセス起動中、期限になったらPortfolio Brainのランキング順でブログを処理します。1ブログだけ失敗した場合は、全体を止めずそのブログだけ再試行キューへ入れます。

現FoundationのSchedulerは**プロセス内タイマー + JSON永続化された次回時刻/再試行キュー**です。サーバー停止中そのものを実行するdurable job workerではないため、本番の高可用性構成では後に専用queue/workerへ置換する前提です。

## Analytics Hub

各Blog Brainには任意で次のAnalytics sourceを追加できます。

### Google Search Console

登録する値:

- site URL
- OAuth access tokenを保持する環境変数名

例:

```bash
export GSC_ACCESS_TOKEN="..."
```

### GA4

登録する値:

- Property ID
- OAuth access tokenを保持する環境変数名

```bash
export GA4_ACCESS_TOKEN="..."
```

### Custom HTTP Metrics

数値を持つJSON objectを返すHTTP endpointも統合できます。

```json
{
  "revenue": 12500,
  "conversions": 18
}
```

Bearer tokenが必要なら、そのtokenを保持する環境変数名だけBloggersへ登録します。

**重要:** 現Foundationでは、Google用にすでに発行済みのOAuth access tokenを利用します。自動refresh / service-account OAuthは次のproduction-hardeningで追加します。

Analytics sourceの一部が取得失敗しても、CMSなど利用可能なデータがあれば運用サイクルは止めず、`analytics.partial` としてAudit Logへ残します。

## Experiment / Learning Engine

AIが実際に `CREATE` を実行すると、その時点の主要指標をbaselineとして実験が始まります。

主要指標は次の優先順位で選びます。

```text
clicks → views → sessions → impressions → users → published → posts
```

その後の観測で変化を追い、一定回数の観測後に:

- positive
- negative
- inconclusive

へ分類します。完了した結果は `Blog Memory` に保存され、次回のAI Director / Writerへコンテキストとして戻ります。

つまり、同じAIでも運用を続けるほど、**そのブログ自身の実測結果から学ぶ**構造です。

## Portfolio Brain

Portfolio Brainは全ブログを横断して、現在の観測値、成長率、直近失敗、承認待ち、進行中実験をもとにスコアを計算します。

Schedulerと手動Portfolio cycleは、このランキング順でブログを処理します。

HQでは:

- Portfolio score
- 成長シグナル
- 優先順位
- 推奨アクション

を確認できます。

## 外部公開時のセキュリティ

Bloggersには記事公開やAI自動運用を実行するAPIがあるため、**localhost以外へ公開する場合は `BLOGGERS_ADMIN_TOKEN` を必ず設定**します。

```bash
export BLOGGERS_ADMIN_TOKEN="十分に長いランダム値"
```

挙動:

- `BLOGGERS_ADMIN_TOKEN` 未設定: APIはlocalhostからだけ利用可能
- `BLOGGERS_ADMIN_TOKEN` 設定済み: `/api/health` 以外のAPIはBearer認証必須
- Web UIは401を受けると管理トークン入力を求める
- 入力したトークンはブラウザの `sessionStorage` にだけ保持する

インターネットへ公開する場合は、HTTPS・リバースプロキシ・ネットワーク側のアクセス制御も使用してください。Foundation版はまだマルチユーザー認証を持ちません。

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
Portfolio Brain
      |
      +---- priority ranking
      |
Autonomous Scheduler
      |
      +-- Blog Brain A
      |      +-- Observer
      |      +-- Director
      |      +-- Writer
      |      +-- Publisher
      |      +-- Learner
      |
      +-- Blog Brain B ... N

Analytics Hub
      +-- CMS metrics
      +-- Search Console
      +-- GA4
      +-- Custom HTTP

Experiment Engine
      |
      +-- measured result
      +-- Blog Memory
             |
             +--> next Director / Writer decision

Connector Layer
      +-- Memory
      +-- WordPress
      +-- future CMS
```

主要コード:

- `src/server.js` — HTTP/API/UI配信・API認証
- `src/store.js` — 永続化
- `src/connectors.js` — CMS Connector abstraction
- `src/analytics.js` — Search Console / GA4 / Custom Metrics
- `src/ai.js` — AI Provider abstraction
- `src/experiments.js` — Experiment / Learning Engine
- `src/portfolio.js` — Portfolio Brain
- `src/orchestrator.js` — Blog運用ループ / 承認 / Emergency Brake
- `src/scheduler.js` — 定時運転 / retry queue
- `src/public/` — 統合HP

## 次の拡張

次の優先候補は以下です。

- OAuth refresh / secrets vault
- Ghost / microCMS Connector
- 既存記事リライト・統合・内部リンク改善
- Source / citation管理とファクトチェック
- durable queue / worker化
- 収益・conversionを使ったExperiment評価
- AIモデルRouting / Cost Governor
- マルチユーザー認証
- PostgreSQLへの永続化移行

## Guardrail

このリポジトリでは、AI開発による意図しない仕様逸脱を防ぐため、`AGENTS.md` と `docs/` の台帳、GitHub Actionsのguardを残しています。

現在の実装対象は `FEATURES.md` の承認済み機能IDに紐づいています。
