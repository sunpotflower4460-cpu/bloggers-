# Bloggers — AI Editorial Operating System

Bloggers は、**AIが複数のブログへ接続し、1つの統合HPから観測・判断・制作/改稿・公開・計測・実験・学習まで回すAI編集部OS**です。

各ブログは独立した `Blog Brain` を持ち、その上に `Portfolio Brain` を置きます。記事数を増やすこと自体を目的にせず、`観測 → 判断 → CREATE / UPDATE / WAIT → Research → 制作 → 品質検査 → 承認/公開 → 計測 → Experiment → Learning` を循環させます。

## 現在の実装

FoundationはNode.js 20+で動き、既存guardrailの制約に従って**新規npm依存0**を維持しています。

- Bloggers HQ 統合ダッシュボード
- 複数ブログ / 独立 Blog Brain
- Portfolio Brain
- Memory / WordPress / Ghost Connector
- CREATE / UPDATE / WAIT
- 既存記事の改稿
- Autonomy Level 0〜5
- Human Gate / Emergency Pause
- Search Console / GA4 / Custom HTTP Metrics
- Google OAuth access token自動refresh（memory-only cache）
- Experiment → Blog Memory
- Research Source / `[S1]` citation gate
- 数値・日付claimの文単位citation検査
- citation先の数値不一致警告
- 内部リンク候補
- Research SSRF / redirect / size / prompt-injection対策
- Director / Writer / Reviser AI Router
- AI Usage Ledger / Cost Governor
- persistent leased Job Queue
- retry / non-retryable failure分類
- blog cycle / approval exclusive lease
- embedded Scheduler / standalone Worker
- viewer / editor / admin RBAC
- Secret Reference Resolver
- JSON literal-secret persistence guard
- JSON Storeのプロセス間transaction lock
- PostgreSQL Store adapter / migration contract
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

### JSON — 現在の標準

```bash
export BLOGGERS_STORAGE_DRIVER=json
export BLOGGERS_DATA_FILE=./data/state.json
```

`JsonStore` は同一Node内のqueueだけでなく、`state.json.lock` を使う**プロセス間transaction lock**を持ちます。

```text
Web process ─┐
             ├─ filesystem transaction lock → state.json
Worker A ────┤
Worker B ────┘
```

書き込みは一時ファイルからatomic renameし、stale lockは期限後に回収します。lock ownerを記録するため、古いprocessが新しいprocessのlockを誤って解放しないようにしています。

設定:

```bash
BLOGGERS_JSON_LOCK_TIMEOUT_MS=10000
BLOGGERS_JSON_STALE_LOCK_MS=300000
```

同一共有filesystem上のWeb + Worker分離には使えますが、複数ホストを跨ぐ本番クラスタ向けではありません。

### PostgreSQL — Adapter / Migration ready

`src/postgres-store.js` に実Store adapter、`db/postgres/001_state_store.sql` に初期migrationを追加しています。

PostgreSQL側ではmutationごとに、

```sql
BEGIN;
SELECT document ... FOR UPDATE;
-- mutation
UPDATE bloggers_state ...;
COMMIT;
```

というtransaction境界を使います。現在のstate documentを最初から細かく分解せず移行するため、既存ロジックを崩さずmulti-host transactionへ移せる構成です。

ただし、現PRには `pg` 等のDB driverを**同梱していません**。これは `CONSTRAINTS.md` の「新規依存0」を守るためです。`PostgresStore` はpoolをdependency injectionする設計で、driver導入が承認された段階でstock runtimeから接続します。

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

lease期限を過ぎた`running` Jobは次回tickで回収します。

同じ`dedupeKey`を持つJobは、**queuedだけでなくrunning中もactive**として扱います。複数Workerが同じscheduled jobを同時登録しても、実行中Jobの横に重複Jobを生成しません。

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

ロール:

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
             |                 SELECT FOR UPDATE
             |
      Persistent Job Queue
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
- `src/storage.js` — Storage factory / backend contract
- `src/store.js` — JsonStore / process lock / atomic persistence
- `src/postgres-store.js` — injected PostgreSQL adapter
- `db/postgres/001_state_store.sql` — PostgreSQL initial migration
- `src/jobs.js` — leased Job Queue
- `src/scheduler.js` — Scheduler / Worker loop
- `src/runtime.js` / `src/leases.js` — operation exclusivity
- `src/connectors.js` — CMS connectors
- `src/orchestrator.js` — editorial loop
- `src/quality.js` — research / citation / claim checks
- `src/analytics.js` / `src/experiments.js` — measurement / learning
- `src/auth.js` / `src/secrets.js` — RBAC / secret boundary

## 次のproduction-hardening候補

- PostgreSQL driver導入承認後のstock runtime接続
- state documentからjobs / locks / blogs等を段階的に正規化
- PostgreSQL `SKIP LOCKED` を使う高並列Job lease
- managed Secrets backend
- OIDC / session-based identity
- microCMS / Contentful等の追加Connector
- semantic / AI-assisted fact verification
- Google service account
- conversion / revenue中心のExperiment評価
- provider固有Adapter / pricing registry

## Guardrail

`AGENTS.md`、`docs/` の台帳、GitHub Actions guardを維持し、承認済みfeature IDの範囲だけを実装します。
