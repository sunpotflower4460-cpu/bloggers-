# Bloggers — AI Editorial Operating System

Bloggers は、**AIが複数のブログへ接続し、1つの統合HPから観測・判断・制作/改稿・公開・計測・実験・学習まで回すAI編集部OS**です。

各ブログは独立した `Blog Brain` を持ち、読者・文体・目的・収益方針・Research Source・Analytics接続を分離します。その上に `Portfolio Brain` を置き、ブログ群全体を横断して「次にどのブログへ時間とAIコストを使うか」を判断します。

## 現在の実装

Foundationは外部npm依存なし、Node.js標準機能だけで起動できます。

- Bloggers HQ 統合ダッシュボード
- 複数ブログ登録 / 独立 Blog Brain
- Memory / WordPress / Ghost Connector
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
- 数値・日付を含む主張のclaim-level citation検査
- 引用先抜粋との数値不一致検出
- 内部リンク候補抽出
- Research URLのSSRF防御 / サイズ上限 / redirect拒否
- 外部Source prompt-injection対策
- Director / Writer / ReviserのAI model routing
- AI token usage ledger / Cost Governor
- 月間reserve到達直後の追加AI呼び出し停止
- JSON-backed leased Job Queue
- 定時Autonomous Scheduler / retry / non-retryable failure分類
- blog cycle / approval のexclusive operation lease
- AI Activity / Workflow / Job監査
- viewer / editor / admin のtoken RBAC
- Secret Reference Resolver / JSONへのliteral secret保存拒否
- CMS / Analytics / AI / OAuth の有限timeout
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
2. Connectorを `Memory / WordPress / Ghost` から選ぶ
3. 必要ならSearch Console / GA4を接続
4. 信頼するResearch Sourceを登録し、必要なら「出典必須」をON
5. `AI運用サイクル` を一度手動実行
6. `Content` で企画・下書き・quality判定を確認
7. `Analytics` で観測・Experiment・Blog Memoryを確認
8. `Settings` でAI予算とSchedulerを設定
9. 問題があれば `PAUSE ALL AI` で全自動操作を即停止

## CMS Connector

### Memory / Demo

外部CMSを使わず、BloggersのJSON state内に疑似postを保存します。AIパイプライン・承認・Experimentを安全に試す用途です。

### WordPress

登録するもの:

- WordPress URL
- usernameを保持する環境変数名
- Application Passwordを保持する環境変数名

```bash
export WP_MUSIC_USER="editor"
export WP_MUSIC_PASSWORD="xxxx xxxx xxxx xxxx"
```

Bloggersへ保存するのは `WP_MUSIC_USER` / `WP_MUSIC_PASSWORD` という**参照名だけ**です。

### Ghost

Ghost Admin APIのCustom Integrationを作成し、Admin API keyを環境変数へ置きます。

```bash
export GHOST_MUSIC_ADMIN_KEY="<id>:<hex-secret>"
```

Blogs画面では次を登録します。

- Ghost Admin URL（例 `https://your-site.ghost.io`）
- Admin API keyを保持する環境変数名（例 `GHOST_MUSIC_ADMIN_KEY`）
- Admin API version（既定 `v6.0`）

Ghost ConnectorはAdmin API keyから**有効期間5分のHS256 JWT**を都度生成し、`Authorization: Ghost <jwt>` で接続します。下書きはHTML sourceとして作成し、MarkdownベースのAI本文を基本HTMLへ変換します。既存記事の更新・公開前には最新postを再取得し、Ghostのcollision detectionに必要な `updated_at` を必ず送ります。

Ghost Admin API keyそのものはJSONへ保存しません。

## Research / Citation / Claim Quality Gate

Blog Brainごとに最大6件の公開Research Sourceを登録できます。

```text
OpenAI Docs | https://platform.openai.com/docs
https://example.com/primary-source
```

Writer / Reviserには本文の抜粋と `S1`, `S2` ... のsource IDだけを渡します。外部Sourceの本文は**未信頼データ**として扱い、そこに含まれる命令には従わないようAIへ明示します。

品質チェック:

- 存在しない `[S9]` 等を引用していないか
- 「出典必須」なのに利用可能Sourceが0件ではないか
- 「出典必須」なのに本文にcitationがないか
- 数値・割合・日付等を含む検証可能な主張の**同じ文**にcitationが付いているか
- 引用したSource抜粋に本文が主張する数値が見つかるか
- 関連する内部リンク候補があるのに利用されていないか

`主張です。[S1]` のような句点直後citationも同じclaimへ結び付けて検証します。

出典必須なのにclaim単位のcitationがない場合はblocking issueです。引用Sourceに数値が見つからない場合は現Foundationでは警告にし、人間または今後の強いFact Checkerで再確認できるよう `claimChecks` に残します。

blocking issueがある場合、**Autonomy Level 4以上でも自動公開せずHuman Gateへ降格**します。

Research fetchは `http/https` の公開URLだけを許可し、localhost、private IP、private addressへ解決されるhostを拒否します。redirectも自動追跡せず、1sourceあたりの取得量を制限します。

## AI Router / Cost Governor

外部AIはOpenAI互換 `/chat/completions` endpointへ接続します。

```bash
export BLOGGERS_AI_BASE_URL="https://provider.example/v1"
export BLOGGERS_AI_API_KEY="..."
export BLOGGERS_AI_MODEL="fallback-model"
```

役割別routing:

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

モデル別価格には `BLOGGERS_AI_PRICING_JSON` を利用できます。`Settings` では月間上限、1サイクル上限、reserveを設定できます。

Cost Governorはcycle開始時だけでなく**各AI呼び出しのusage保存直後にも月間残額を再評価**します。Director callでreserveへ到達した場合、そのusageは記録したうえでWriter/Reviserへの追加callを止めます。予算到達はSchedulerではnon-retryableとして扱います。

APIキーがない場合は `RuleBasedProvider` がローカルで動き、費用0でシステムの流れを検証できます。

## Durable Job Queue / Scheduler

Schedulerは実行前にJobをJSONへ永続化してからleaseを取得します。

```text
queued
  ↓ lease
running
  ├─ success → completed
  ├─ transient failure → queued(retry) → failed
  └─ non-retryable failure → failed
```

プロセスが `running` 中に終了しても、lease期限を過ぎたJobは次回worker tickで再び `queued` として回収されます。

`Settings` からON/OFF、実行間隔（最短15分）、最大リトライ、リトライ間隔を設定できます。

Portfolio cycle自体をJobとして保存し、個別ブログ失敗時はそのブログだけ `blog-cycle` Jobとして隔離します。月間AI予算reserve到達など、再試行しても直らない失敗は再キューしません。

blog cycleとapprovalには別のexclusive operation leaseがあり、手動実行とSchedulerの競合、承認の二重処理を抑えます。異常終了時はlease期限後に回収できます。

現Foundationでは**JSON-backed queue + 同一Nodeプロセス内worker**です。Job自体は再起動耐性がありますが、複数workerによる分散実行やDB transactionを使う本番queueは将来のPostgreSQL/worker化で置換します。

## Analytics Hub / Google OAuth

Blog Brainには任意でSearch Console、GA4、Custom HTTP Metricsを接続できます。

推奨Google OAuth構成:

```bash
export GOOGLE_REFRESH_TOKEN="..."
export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
```

Bloggersは固定のGoogle token endpointでaccess tokenを更新し、更新後tokenは**プロセスメモリにだけキャッシュ**します。`state.json` にはrefresh token・client secret・更新後access tokenの値を書きません。

互換用に発行済みaccess token方式も残しています。

```bash
export GSC_ACCESS_TOKEN="..."
export GA4_ACCESS_TOKEN="..."
```

Custom HTTP Metricsは数値JSONを返すendpointを統合できます。Analytics sourceの一部が取得失敗しても、利用可能データでcycleを続け、`analytics.partial` をAudit Logへ残します。

## RBAC / API Security

認証未設定では、APIはlocalhostからだけ利用でき、そのローカル接続をadminとして扱います。外部公開時はtoken認証を設定してください。

従来方式の `BLOGGERS_ADMIN_TOKEN` は互換性のため残っており、常にadminです。

複数ロールでは、**token値ではなくtokenを保持する環境変数名**を `BLOGGERS_RBAC_JSON` に登録します。

```bash
export BLOGGERS_VIEWER_TOKEN="..."
export BLOGGERS_EDITOR_TOKEN="..."
export BLOGGERS_RBAC_JSON='[
  {"id":"reader","role":"viewer","tokenEnv":"BLOGGERS_VIEWER_TOKEN"},
  {"id":"operator","role":"editor","tokenEnv":"BLOGGERS_EDITOR_TOKEN"}
]'
```

| Role | 主な権限 |
|---|---|
| viewer | HQ / Blogs / Content / Analytics / Activity / Settingsの閲覧。Job詳細とAI usage詳細はredact |
| editor | viewer + ブログ登録/更新、接続テスト、AI cycle、承認、Emergency Pause、Job閲覧 |
| admin | editor + Resume、AI予算・Scheduler等のSettings変更 |

Emergency Pauseは安全側へ倒す操作なのでeditorにも許可しますが、再開はadminだけです。HQ UIも現在のroleを表示し、権限のない主要操作をdisableします。サーバー側RBACが最終的な強制境界です。

Web UIへ入力したBearer tokenは `sessionStorage` にだけ保持します。

## Secret Reference Boundary

Bloggersの永続データにはcredential値を置かず、`WP_MUSIC_PASSWORD` や `GHOST_MUSIC_ADMIN_KEY` のような**Secret Reference**だけを保存します。現在のResolver backendは環境変数です。

```text
state.json: passwordEnv = "WP_MUSIC_PASSWORD"
process env: WP_MUSIC_PASSWORD = "actual secret"
```

`passwordEnv`, `accessTokenEnv`, `bearerTokenEnv`, `adminKeyEnv` などSecret Reference用フィールドへ実パスワードやAPIキーらしい文字列を書こうとすると、`JsonStore` が保存を拒否します。

WordPress / Ghost / Google OAuth / Custom Analytics / RBAC / AI API key は共通Resolver境界を通して取得します。将来AWS Secrets Manager、GCP Secret Manager、1Password Connect、Vault等を追加する場合は、この境界へbackendを追加します。

## Experiment / Learning Engine

CREATE / UPDATEが実際に公開・反映された時点でbaselineを保存しExperimentを開始します。

主要指標:

```text
clicks → views → sessions → impressions → users → published → posts
```

後続観測から `positive / negative / inconclusive` を判定し、完了結果だけを `Blog Memory` へ昇格します。次のDirector / Writer / Reviserはこの実測学習を受け取ります。

## Portfolio Brain

Portfolio Brainは観測値、成長率、直近失敗、承認待ち、進行中Experimentからブログをスコアリングします。手動Portfolio cycleとSchedulerはこのランキング順に実行します。

## Autonomy Level

| Level | 動作 |
|---|---|
| 0 | 観測のみ |
| 1 | AI提案のみ |
| 2 | 下書き/改稿案まで自動 |
| 3 | 公開・改稿反映前に人間承認 |
| 4 | 品質ゲートを通過した変更を自動反映 |
| 5 | 将来の完全自律運営用 |

品質ゲート・Cost Governor・Emergency Pause・RBAC・削除禁止はAutonomyより優先されます。

## アーキテクチャ

```text
Portfolio Brain
      |
Persistent Job Queue + Scheduler
      |
Exclusive Operation Leases
      |
      +-- Blog Brain A ... N
              |
              +-- Observer / Analytics
              +-- Director
              +-- Research / Claim Quality Gate
              +-- Writer / Reviser
              +-- Publisher
              +-- Experiment / Learner

AI Router
      +-- Director model
      +-- Writer model
      +-- Reviser model
      +-- Cost Governor / Usage Ledger

Auth / Secret Boundary
      +-- viewer / editor / admin
      +-- Env Secret Resolver

Connector Layer
      +-- Memory
      +-- WordPress
      +-- Ghost
      +-- future CMS
```

主要コード:

- `src/server.js` — HTTP/API/UI・RBAC
- `src/auth.js` — token authentication / role policy
- `src/secrets.js` — Secret Reference validation / Resolver
- `src/store.js` — JSON永続化 / secret-reference persistence guard
- `src/connectors.js` — Memory / WordPress / Ghost Connector
- `src/oauth.js` — Google OAuth refresh / memory-only token cache
- `src/analytics.js` — GSC / GA4 / Custom Metrics
- `src/ai.js` — AI Router / Provider
- `src/cost.js` — Usage Ledger / Cost Governor
- `src/quality.js` — Research / citation / claim / internal-link quality
- `src/jobs.js` — persistent leased Job Queue
- `src/leases.js` — exclusive operation leases
- `src/runtime.js` — exclusive cycle / approval wrappers
- `src/experiments.js` — Experiment / Learning
- `src/portfolio.js` — Portfolio Brain
- `src/orchestrator.js` — Blog運用ループ / Human Gate / Emergency Brake
- `src/scheduler.js` — Job worker / 定時運転
- `src/public/` — 統合HP

## 次のproduction-hardening候補

- PostgreSQL + transaction based queue
- 独立worker / multi-instance DB lease
- 実Vault backend / managed secret store
- OIDC / session-based multi-user identity
- microCMS / Contentful等の追加Connector
- semantic / AI-assisted claim fact verification
- Google service account対応
- conversion / revenueを含むExperiment評価
- provider固有Adapterとより精密な価格表

## Guardrail

`AGENTS.md`、`docs/` の台帳、GitHub Actions guardを残し、実装を承認済みfeature IDへ紐づけています。
