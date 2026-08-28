# Bloggers — AI Editorial Operating System

Bloggers は、**AIが複数のブログへ接続し、1つの統合HPから観測・判断・制作/改稿・公開・計測・実験・学習まで回すAI編集部OS**です。

各ブログは独立した `Blog Brain` を持ち、その上に `Portfolio Brain` を置きます。記事数を増やすこと自体を目的にせず、`観測 → 判断 → CREATE / UPDATE / WAIT → Research → 制作 → 品質検査 → 承認/公開 → 計測 → Experiment → Learning` を循環させます。

## 現在の実装

FoundationはNode.js 20+で動き、既存guardrailの制約に従って**新規npm依存0**を維持しています。

- Bloggers HQ 統合ダッシュボード
- 複数ブログ / 独立 Blog Brain / Portfolio Brain
- Memory / WordPress / Ghost Connector
- CREATE / UPDATE / WAIT / 既存記事改稿
- Autonomy Level 0〜5 / Human Gate / Emergency Pause
- Search Console / GA4 / Custom HTTP Metrics
- Google OAuth access token自動refresh（memory-only cache）
- Experiment → Blog Memory
- Research Source / `[S1]` citation gate
- 数値・日付claimの文単位citation検査 / 数値不一致警告
- 内部リンク候補
- Research SSRF / redirect / size / prompt-injection対策
- Director / Writer / Reviser AI Router
- AI Usage Ledger / Cost Governor
- persistent leased Job Queue / retry / non-retryable分類
- Job owner / heartbeat / stale-worker fencing
- blog cycle / approval exclusive lease
- embedded Scheduler / standalone Worker
- viewer / editor / admin RBAC
- Secret Reference Resolver / literal-secret persistence guard
- JSON Storeのプロセス間transaction lock + atomic write
- PostgreSQL Store adapter
- PostgreSQL native jobs / operation leases
- `FOR UPDATE SKIP LOCKED` worker leasing
- JSON → PostgreSQL migration command
- deployment-provided PostgreSQL pool module hook
- Audit Log
- Node標準テスト / GitHub Actions

## 起動

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

検証:

```bash
npm run check
npm test
npm run guard
npm run guard:selftest
```

## 自律運転

### Embedded mode

既定ではWebプロセス内でSchedulerも動きます。

```bash
export BLOGGERS_SCHEDULER_MODE=embedded
npm start
```

小規模運用・ローカル検証向けです。

### Standalone Worker mode

Webと自律実行を分離できます。

Web:

```bash
export BLOGGERS_SCHEDULER_MODE=external
npm start
```

Worker:

```bash
npm run worker
```

WebとWorkerは同じStorageを共有します。Health / Settings APIには `schedulerMode` と現在のStorage backendを返します。

## Storage / Transaction Boundary

### JSON — 標準backend

```bash
export BLOGGERS_STORAGE_DRIVER=json
export BLOGGERS_DATA_FILE=./data/state.json
```

`JsonStore` は `state.json.lock` を使う**プロセス間transaction lock**を持ちます。

```text
Web process ─┐
             ├─ filesystem transaction lock → state.json
Worker A ────┤
Worker B ────┘
```

書き込みは一時ファイルからatomic renameし、stale lockは期限後に回収します。lock ownerを記録するため、古いprocessが新しいprocessのlockを誤って解放しないようにしています。

```bash
BLOGGERS_JSON_LOCK_TIMEOUT_MS=10000
BLOGGERS_JSON_STALE_LOCK_MS=300000
```

同一共有filesystem上のWeb + Worker分離には使えますが、複数ホストを跨ぐ本番クラスタ向けではありません。

### PostgreSQL — native hot-path ready

PostgreSQL側には次を実装しています。

- `src/postgres-store.js` — Store adapter
- `db/postgres/001_state_store.sql` — state document
- `db/postgres/002_jobs_leases.sql` — normalized jobs / operation leases
- Job lease取得の `FOR UPDATE SKIP LOCKED`
- active dedupe partial unique index
- Job owner / heartbeat / fencing
- DB-native operation lease
- JSON → PostgreSQL migration command

一般stateのmutationは、

```sql
BEGIN;
SELECT document ... FOR UPDATE;
-- mutation
UPDATE bloggers_state ...;
COMMIT;
```

で整合性を保ちます。一方、競合頻度の高いJob Queueとoperation leaseは独立テーブルへ正規化し、複数Workerが同じglobal state rowを取り合わずに動けるようにしています。

#### PostgreSQL poolの接続

現PRは `CONSTRAINTS.md` の「新規依存0」を守るため、`pg`等のdriverを**同梱していません**。代わりにデプロイ環境が提供するESM moduleを読み込めます。

```bash
export BLOGGERS_STORAGE_DRIVER=postgres
export BLOGGERS_POSTGRES_POOL_MODULE=./deploy/postgres-pool.mjs
export DATABASE_URL='postgres://...'
npm start
```

moduleは次のいずれかをexportします。

```js
export const pool = yourPool
// または
export default yourPool
// または
export async function createPool({ env }) {
  return yourPool
}
```

pool contractは `connect()` と `query()` です。WebとWorkerは同じ設定を使えます。

#### JSONからPostgreSQLへ移行

```bash
export BLOGGERS_POSTGRES_POOL_MODULE=./deploy/postgres-pool.mjs
export BLOGGERS_MIGRATION_JSON_FILE=./data/state.json
npm run migrate:postgres
```

移行では通常state、ブログ、記事、Analytics、Experiment、Memory等をコピーし、Jobはnative `bloggers_jobs`へ移します。

安全のため、移行時点で`running`だったJobは**queuedへ戻してlease ownerを破棄**し、新Workerが再取得できるようにします。旧operation leaseは新環境へ持ち込まず破棄します。移行コマンドは既存Job IDを見て再実行時の重複も避けます。

## Durable Job Queue

Jobは実行前に永続化し、leaseを取得します。

```text
queued
  ↓ lease
running
  ├─ success → completed
  ├─ transient failure → queued(retry) → failed
  └─ non-retryable failure → failed
```

同じ`dedupeKey`を持つJobは、**queuedだけでなくrunning中もactive**です。

長い処理ではWorkerがleaseをheartbeat更新します。Worker停止後にleaseが切れ、別WorkerがJobを再取得した場合、古いWorkerはowner fencingにより`complete/fail`できません。

JSON backendではfilesystem transaction内でleaseします。PostgreSQL backendではdue Jobを `FOR UPDATE SKIP LOCKED` で取得するため、複数Workerが別Jobを並列処理できます。

AI月間reserve到達など、再試行しても直らない失敗はnon-retryableです。

## CMS Connector

### Memory / Demo

外部CMSなしでパイプラインを安全に検証します。

### WordPress

保存するのはcredential値ではなく環境変数名です。

```bash
export WP_MUSIC_USER="editor"
export WP_MUSIC_PASSWORD="xxxx xxxx xxxx xxxx"
```

### Ghost

Custom Integration Admin API keyを環境変数に置きます。

```bash
export GHOST_MUSIC_ADMIN_KEY="<id>:<hex-secret>"
```

Ghost Connectorは短命HS256 JWTを生成し、HTML draft、既存記事UPDATE、publishに対応します。UPDATE / publish前には最新postを取得し、collision detection用 `updated_at` を送ります。

## Research / Citation / Claim Quality Gate

Research Source本文は**未信頼データ**として扱い、そこに含まれる命令をAIへ実行させない前提です。

品質検査:

- 存在しないsource ID
- 出典必須なのにsourceなし
- 出典必須なのに本文citationなし
- 数値・割合・日付等を含むclaimの同一文citation
- citation先抜粋で数値を確認できるか
- 関連内部リンク候補

`主張です。[S1]` のような句点直後citationも同じclaimへ結び付けます。

blocking issueがあれば**Autonomy Level 4以上でも自動公開せずHuman Gateへ降格**します。

Research fetchは公開HTTP(S)だけを許可し、localhost/private network、redirect、過大レスポンスを拒否します。

## AI Router / Cost Governor

OpenAI-compatible `/chat/completions` endpointを利用できます。

```bash
export BLOGGERS_AI_BASE_URL="https://provider.example/v1"
export BLOGGERS_AI_API_KEY="..."
export BLOGGERS_AI_MODEL="fallback-model"
export BLOGGERS_AI_DECIDE_MODEL="reasoning-model"
export BLOGGERS_AI_WRITE_MODEL="writing-model"
export BLOGGERS_AI_REVISE_MODEL="editing-model"
```

モデル別pricingを設定するとusageから概算費用を記録します。

Cost Governorはcycle開始時だけでなく**各AI callのusage保存直後**にも月間reserveを再判定します。Director callでreserveへ到達した場合、そのusageは記録し、同じcycleのWriter / Reviserを止めます。

API key未設定時は費用0の`RuleBasedProvider`で流れを検証できます。

## Analytics / Learning

Analytics HubはCMS metricsに加えて、Search Console / GA4 / Custom HTTP Metricsを統合します。

Google OAuth:

```bash
export GOOGLE_REFRESH_TOKEN="..."
export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
```

refresh後access tokenはプロセスメモリだけへ保持します。

CREATE / UPDATEが実際に反映された時点でExperimentを開始し、`positive / negative / inconclusive` の完了結果だけをBlog Memoryへ昇格します。

## RBAC / Secret Boundary

認証未設定ではAPIはlocalhost限定です。

| Role | 主な権限 |
|---|---|
| viewer | HQ / Blogs / Content / Analytics / Activity / Settings閲覧 |
| editor | viewer + blog操作 / AI cycle / approval / Emergency Pause |
| admin | editor + Resume / AI予算 / Scheduler設定 |

既存`BLOGGERS_ADMIN_TOKEN`はadmin互換です。複数ロールでは`BLOGGERS_RBAC_JSON`にtoken値ではなく**tokenを保持する環境変数名**を登録します。

Secret Reference用フィールドへ実password/API keyらしい値を書こうとするとStoreが保存を拒否します。WordPress / Ghost / Google OAuth / Custom Analytics / RBAC / AI API keyは共通Resolver境界を通します。

## アーキテクチャ

```text
                    Bloggers HQ / API
                           |
                    Storage Contract
                    /              \
      JsonStore + fs lock       PostgresStore
             |                  /           \
      state.json        bloggers_state   jobs / leases
             |                          SKIP LOCKED
             └──────────────┬───────────────┘
                            |
                 Embedded / External Worker
                            |
                      Portfolio Brain
                            |
                     Blog Brain A ... N
                            |
       Observer → Director → Research → Writer/Reviser
                            ↓
             Quality Gate → Human Gate/Publisher
                            ↓
              Analytics → Experiment → Learning

Connector Layer: Memory / WordPress / Ghost
AI Layer: Director / Writer / Reviser + Cost Governor
Security: RBAC + Secret Resolver + Emergency Pause
```

主要コード:

- `src/server.js` — HTTP/API/UI
- `src/worker.js` — standalone autonomous worker
- `src/storage.js` — Storage factory / optional PostgreSQL pool module loader
- `src/store.js` — JsonStore / process lock / atomic persistence
- `src/postgres-store.js` — PostgreSQL state + native queue/lease adapter
- `src/migrate-to-postgres.js` — safe JSON → PostgreSQL migration
- `db/postgres/001_state_store.sql` — state migration
- `db/postgres/002_jobs_leases.sql` — jobs / leases migration
- `src/jobs.js` — backend-capability aware leased Job Queue
- `src/scheduler.js` — Scheduler / Worker loop
- `src/runtime.js` / `src/leases.js` — operation exclusivity
- `src/connectors.js` — CMS connectors
- `src/orchestrator.js` — editorial loop
- `src/quality.js` — research / citation / claim checks
- `src/analytics.js` / `src/experiments.js` — measurement / learning
- `src/auth.js` / `src/secrets.js` — RBAC / secret boundary

## 次のproduction-hardening候補

- PostgreSQL driverの正式依存化（guard制約変更の承認後）
- blogs / articles / analytics / experiments等の段階的正規化
- managed Secrets backend
- OIDC / session-based identity
- microCMS / Contentful等の追加Connector
- semantic / AI-assisted fact verification
- Google service account
- conversion / revenue中心のExperiment評価
- provider固有Adapter / pricing registry

## Guardrail

`AGENTS.md`、`docs/` の台帳、GitHub Actions guardを維持し、承認済みfeature IDの範囲だけを実装します。
