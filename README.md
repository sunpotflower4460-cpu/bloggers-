# Bloggers — AI Editorial Operating System

Bloggers は、**AIが複数のブログへ接続し、1つの統合HPから観測・判断・制作/改稿・公開・計測・実験・学習まで回すAI編集部OS**です。

各ブログは独立した `Blog Brain` を持ち、読者・文体・目的・収益方針・Research Source・Analytics接続を分離します。その上に `Portfolio Brain` を置き、ブログ群全体を横断して「次にどのブログへ時間とAIコストを使うか」を判断します。

## 現在の実装

現在のFoundationは外部npm依存なし、Node.js標準機能だけで起動できます。

- Bloggers HQ 統合ダッシュボード
- 複数ブログ登録 / 独立 Blog Brain
- Memory / WordPress Connector
- CREATE / UPDATE / WAIT の編集判断
- 既存記事の実改稿フロー
- Autonomy Level 0〜5
- 公開・改稿のHuman Gate
- Emergency Pause / Resume
- CMS + Search Console + GA4 + Custom HTTP Metrics
- Google OAuth access tokenの自動refresh / メモリキャッシュ
- Portfolio Brainによる優先順位付け
- Experiment / Learning Engine
- Blog Memoryへの実測学習
- Research Source収集
- `[S1]`形式のcitation quality gate
- 内部リンク候補抽出
- Research URLのSSRF防御 / サイズ上限 / redirect拒否
- 外部Source prompt-injection対策
- Director / Writer / ReviserのAI model routing
- AI token usage ledger / Cost Governor
- JSON-backed leased Job Queue
- 定時Autonomous Scheduler / retry
- AI Activity / Workflow / Job監査
- 管理トークンによるAPI保護
- Node標準テスト / 構文チェック

## 起動

必要環境: Node.js 20+

```bash
npm start
```

ブラウザ:

```text
http://localhost:3000
```

開発:

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

1. `Blogs` でブログ名・目的・読者・文体・主要テーマを登録
2. 最初は `Memory / Demo` Connectorでもよい
3. 必要ならWordPress / Search Console / GA4を接続
4. 信頼するResearch Sourceを登録し、必要なら「出典必須」をON
5. `AI運用サイクル` を一度手動実行
6. `Content` で企画・下書き・quality判定を確認
7. `Analytics` で観測・Experiment・Blog Memoryを確認
8. `Settings` でAI予算とSchedulerを設定
9. 問題があれば `PAUSE ALL AI` で全自動操作を即停止

## Research / Citation Quality Gate

Blog Brainごとに最大6件の公開Research Sourceを登録できます。

```text
OpenAI Docs | https://platform.openai.com/docs
https://example.com/primary-source
```

Writer / Reviserには本文の抜粋と `S1`, `S2` ... のsource IDだけを渡します。外部Sourceの本文は**未信頼データ**として扱い、そこに含まれる命令には従わないようAIへ明示します。

品質チェックでは次を確認します。

- 存在しない `[S9]` 等を引用していないか
- 「出典必須」なのに利用可能Sourceが0件ではないか
- 「出典必須」なのに本文にcitationがないか
- 関連する内部リンク候補があるのに利用されていないか

blocking issueがある場合、**Autonomy Level 4以上でも自動公開せずHuman Gateへ降格**します。人間が内容を確認したうえで明示承認することはできます。

Research fetchは `http/https` の公開URLだけを許可し、localhost、private IP、private addressへ解決されるhostを拒否します。redirectも自動追跡せず、1sourceあたりの取得量を制限します。

## AI Router / Cost Governor

外部AIはOpenAI互換 `/chat/completions` endpointへ接続します。

```bash
export BLOGGERS_AI_BASE_URL="https://provider.example/v1"
export BLOGGERS_AI_API_KEY="..."
export BLOGGERS_AI_MODEL="fallback-model"
```

役割別routingもできます。

```bash
export BLOGGERS_AI_DECIDE_MODEL="reasoning-model"
export BLOGGERS_AI_WRITE_MODEL="writing-model"
export BLOGGERS_AI_REVISE_MODEL="editing-model"
```

Pricingを設定するとAPIレスポンスのtoken usageから概算費用を保存します。

```bash
export BLOGGERS_AI_INPUT_USD_PER_1M="1.25"
export BLOGGERS_AI_OUTPUT_USD_PER_1M="10"
```

モデル別価格を使う場合は `BLOGGERS_AI_PRICING_JSON` を利用できます。`Settings` では月間上限、1サイクル上限、reserveを設定できます。月間reserveへ到達した外部AI cycleは開始しません。

APIキーがない場合は `RuleBasedProvider` がローカルで動き、費用0でシステムの流れを検証できます。

## Durable Job Queue / Scheduler

Schedulerは実行前にJobをJSONへ永続化してからleaseを取得します。

```text
queued
  ↓ lease
running
  ├─ success → completed
  └─ failure → queued(retry) → failed
```

プロセスが `running` 中に終了しても、lease期限を過ぎたJobは次回worker tickで再び `queued` として回収されます。

`Settings` から次を設定できます。

- ON / OFF
- 実行間隔（最短15分）
- 最大リトライ回数
- リトライ間隔

Portfolio cycle自体をJobとして保存し、個別ブログ失敗時はそのブログだけ `blog-cycle` Jobとして隔離します。HQ / AI画面ではqueued・running・failed Jobを確認できます。

現Foundationでは**JSON-backed queue + 同一Nodeプロセス内worker**です。Job自体は再起動耐性がありますが、複数workerによる分散実行やDB transactionを使う本番queueは将来のPostgreSQL/worker化で置換できます。

## Analytics Hub / Google OAuth

Blog Brainには任意でSearch Console、GA4、Custom HTTP Metricsを接続できます。

### Google Search Console / GA4

推奨構成では、Search ConsoleとGA4で共有するGoogle OAuth refresh credentialを環境変数へ置きます。

```bash
export GOOGLE_REFRESH_TOKEN="..."
export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
```

Bloggersは固定のGoogle token endpointでaccess tokenを更新し、更新後tokenは**プロセスメモリにだけキャッシュ**します。`state.json` にはrefresh token・client secret・更新後access tokenの値を書きません。

既存運用との互換性のため、すでに発行済みaccess tokenを使う方式もフォールバックとして残しています。

```bash
export GSC_ACCESS_TOKEN="..."
export GA4_ACCESS_TOKEN="..."
```

ブログ側ではSearch Consoleのsite URL、GA4 Property IDと、必要に応じてaccess-token環境変数名だけを登録します。

### Custom HTTP Metrics

数値JSONを返すendpointを統合できます。

```json
{
  "revenue": 12500,
  "conversions": 18
}
```

Analytics sourceの一部が取得失敗しても、利用可能データでcycleを続け、`analytics.partial` をAudit Logへ残します。

## Experiment / Learning Engine

CREATE / UPDATEが実際に公開・反映された時点でbaselineを保存しExperimentを開始します。

主要指標の優先順位:

```text
clicks → views → sessions → impressions → users → published → posts
```

後続観測から `positive / negative / inconclusive` を判定し、完了結果だけを `Blog Memory` へ昇格します。次のDirector / Writer / Reviserはこの実測学習を受け取ります。

## Portfolio Brain

Portfolio Brainは観測値、成長率、直近失敗、承認待ち、進行中Experimentからブログをスコアリングします。手動Portfolio cycleとSchedulerはこのランキング順に実行します。

## 外部公開時のセキュリティ

記事公開やAI自動運用APIがあるため、localhost以外へ公開する場合は `BLOGGERS_ADMIN_TOKEN` を必ず設定します。

```bash
export BLOGGERS_ADMIN_TOKEN="十分に長いランダム値"
```

- 未設定: APIはlocalhostからのみ
- 設定済み: `/api/health` 以外はBearer認証必須
- Web UIのtokenは `sessionStorage` のみ
- WordPress / Google / AIのcredential値はJSONへ保存しない
- 削除操作は常に禁止

インターネットへ公開する場合はHTTPS・リバースプロキシ・ネットワーク制御も併用してください。Foundationはまだマルチユーザー認証を持ちません。

## WordPress接続

登録するもの:

- WordPress URL
- usernameを保持する環境変数名
- Application Passwordを保持する環境変数名

```bash
export WP_MUSIC_USER="editor"
export WP_MUSIC_PASSWORD="xxxx xxxx xxxx xxxx"
```

資格情報そのものはBloggersのJSONへ保存しません。

## Autonomy Level

| Level | 動作 |
|---|---|
| 0 | 観測のみ |
| 1 | AI提案のみ |
| 2 | 下書き/改稿案まで自動 |
| 3 | 公開・改稿反映前に人間承認 |
| 4 | 品質ゲートを通過した変更を自動反映 |
| 5 | 将来の完全自律運営用 |

品質ゲート・Emergency Pause・削除禁止はAutonomyより優先されます。

## アーキテクチャ

```text
Portfolio Brain
      |
Persistent Job Queue + Scheduler
      |
      +-- Blog Brain A ... N
              |
              +-- Observer / Analytics
              +-- Director
              +-- Research / Quality Gate
              +-- Writer / Reviser
              +-- Publisher
              +-- Experiment / Learner

AI Router
      +-- Director model
      +-- Writer model
      +-- Reviser model
      +-- Cost Governor / Usage Ledger

Connector Layer
      +-- Memory
      +-- WordPress
      +-- future CMS
```

主要コード:

- `src/server.js` — HTTP/API/UI・認証
- `src/store.js` — JSON永続化
- `src/connectors.js` — CMS Connector
- `src/oauth.js` — Google OAuth refresh / memory-only token cache
- `src/analytics.js` — GSC / GA4 / Custom Metrics
- `src/ai.js` — AI Router / Provider
- `src/cost.js` — Usage Ledger / Cost Governor
- `src/quality.js` — Research / citation / internal-link quality
- `src/jobs.js` — persistent leased Job Queue
- `src/experiments.js` — Experiment / Learning
- `src/portfolio.js` — Portfolio Brain
- `src/orchestrator.js` — Blog運用ループ / Human Gate / Emergency Brake
- `src/scheduler.js` — Job worker / 定時運転
- `src/public/` — 統合HP

## 次のproduction-hardening候補

- secrets vault / encrypted credential store
- Google service account対応
- Ghost / microCMS Connector
- topic-aware Research discovery / claim-level fact verification
- conversion / revenueを含むExperiment評価
- PostgreSQL + transaction based queue
- 独立worker / multi-instance lease
- マルチユーザー認証 / RBAC
- provider固有Adapterとより精密な価格表

## Guardrail

`AGENTS.md`、`docs/` の台帳、GitHub Actions guardを残し、実装を承認済みfeature IDへ紐づけています。
