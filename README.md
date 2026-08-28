# Bloggers — AI Editorial Operating System

Bloggers は、**AIが複数ブログへ接続し、1つの統合HPから観測・判断・制作/改稿・公開・計測・実験・学習まで回すAI編集部OS**です。

各ブログは独立した `Blog Brain` を持ち、その上に `Portfolio Brain` を置きます。記事数を増やすこと自体を目的にせず、`観測 → 判断 → CREATE / UPDATE / WAIT → Research → 制作 → 品質検査 → 承認/公開 → 計測 → Experiment → Learning` を循環させます。

## 現在の実装

FoundationはNode.js 20+で動き、既存guardrailの制約に従って**新規npm依存0**を維持しています。

- Bloggers HQ / 複数Blog Brain / Portfolio Brain
- Memory / WordPress / Ghost Connector
- CREATE / UPDATE / WAIT / 既存記事改稿
- Autonomy Level 0〜5 / Human Gate / Emergency Pause
- Search Console / GA4 / Custom HTTP Metrics
- Google OAuth refresh（access tokenはmemory-only）
- Experiment → Blog Memory
- Research Source / `[S1]` citation / claim単位の数値・日付検証
- 内部リンク候補 / SSRF / redirect / size / prompt-injection対策
- Director / Writer / Reviser AI Router
- AI Usage Ledger / Cost Governor
- persistent leased Job Queue / retry / non-retryable分類
- bounded Worker concurrency（default 4 / 1〜20）
- Job owner / heartbeat / stale-worker fencing
- blog cycle / approval operation lease + heartbeat
- Connector書き込み直前のJob + Operation二重fence
- WordPress / Ghost remote draftのretry-idempotency
- embedded Scheduler / standalone Worker
- viewer / editor / admin token RBAC
- OIDC Authorization Code + PKCE / HttpOnly signed Session
- env / managed Secret Reference Resolver
- literal-secret persistence guard
- JSON Storeのcross-process transaction lock + atomic write
- PostgreSQL state adapter + normalized jobs / operation leases
- `FOR UPDATE SKIP LOCKED` worker leasing
- JSON → PostgreSQL migration command
- deployment-provided PostgreSQL pool module hook
- Audit Log
- Node標準テスト / GitHub Actions

## 起動

```bash
npm start
```

既定のローカルURL:

```text
http://localhost:3000
```

Standalone Workerを使う場合:

```bash
export BLOGGERS_SCHEDULER_MODE=external
npm start
```

別process:

```bash
npm run worker
```

検証:

```bash
npm run check
npm test
npm run guard
npm run guard:selftest
```

## Storage / Worker

### JSON — 標準backend

```bash
export BLOGGERS_STORAGE_DRIVER=json
export BLOGGERS_DATA_FILE=./data/state.json
```

`JsonStore` は `state.json.lock` によるowner付きcross-process transaction lockとatomic renameを使います。同じ共有filesystem上ならWeb + standalone Workerを分離できます。

```text
Web process ─┐
Worker A ────┼─ filesystem transaction lock → state.json
Worker B ────┘
```

複数ホストを跨ぐproduction clusterではPostgreSQLを使います。

### PostgreSQL — native hot path

実装済み:

- `bloggers_state` — 一般state document
- `bloggers_jobs` — normalized durable jobs
- `bloggers_operation_leases` — normalized operation leases
- queued Jobの `FOR UPDATE SKIP LOCKED`
- queued/runningを対象にしたactive dedupe partial unique index
- Job heartbeat / owner fencing
- Operation lease heartbeat / owner fencing
- JSON → PostgreSQL migration

一般state mutationは `SELECT ... FOR UPDATE` transactionで整合性を保ち、競合頻度が高いJob/Leaseだけを独立テーブルへ逃がしています。

現PRは「新規npm依存0」を守るため `pg` 等を同梱していません。デプロイ環境側のESM pool moduleを読み込みます。

```bash
export BLOGGERS_STORAGE_DRIVER=postgres
export BLOGGERS_POSTGRES_POOL_MODULE=./deploy/postgres-pool.mjs
export DATABASE_URL='postgres://...'
npm start
```

pool moduleは `pool` / `default` / `createPool({ env })` のいずれかをexportし、返すpoolは `connect()` と `query()` を実装します。

JSONから移行する場合:

```bash
export BLOGGERS_POSTGRES_POOL_MODULE=./deploy/postgres-pool.mjs
export BLOGGERS_MIGRATION_JSON_FILE=./data/state.json
npm run migrate:postgres
```

移行時に`running`だったJobは`queued`へ戻して旧ownerを破棄し、旧operation leaseも引き継ぎません。

## Durable execution / side-effect fencing

Jobは実行前に永続化し、leaseを取得します。

```text
queued
  ↓ lease
running
  ├─ success → completed
  ├─ transient failure → queued(retry)
  └─ non-retryable failure → failed
```

同じ`dedupeKey`はqueued/runningの両方をactiveとして扱います。Workerは`BLOGGERS_WORKER_CONCURRENCY`件だけJobをleaseし、その件数をすぐ並列処理します。大量Jobを先取りしてheartbeat前に期限切れさせる構造は取りません。

長いJobはheartbeatでleaseを更新し、別Workerへownerが移った後は古いWorkerの`complete/fail`を拒否します。

さらに、完了時だけでは不十分なので、**CMSへの外部書き込み直前にもlease ownershipを再検証**します。

```text
Scheduled publish/update
  ├─ Job lease owner OK?
  ├─ Blog/Approval operation lease owner OK?
  └─ both OK → Connector write
```

実行contextは`AsyncLocalStorage`で伝播します。Scheduler配下ではJob fence + Operation fence、手動cycle/approvalではOperation fenceが有効です。ownerを失った処理はnon-retryableとして止めます。

## CMS Connector / retry idempotency

### Memory

ローカル検証用。article IDで同一draftを再利用します。

### WordPress

Application Password等はSecret Referenceとして保持します。

```bash
export WP_MUSIC_USER='editor'
export WP_MUSIC_PASSWORD='xxxx xxxx xxxx xxxx'
```

CREATEでは`bloggers-{articleId}`の決定的slugを使い、POST前に同じslugの既存postを検索します。CMS側で作成成功後にWorkerが落ちても、retry時には既存postを再利用します。

### Ghost

Custom Integration Admin API keyから短命HS256 JWTを生成します。

```bash
export GHOST_MUSIC_ADMIN_KEY='<id>:<hex-secret>'
```

Ghostも同じ決定的slugを使い、Admin APIのslug lookupで既存postを確認してから作成します。UPDATE / publish前には最新postを取得し、collision detection用`updated_at`を送ります。

## Secret Boundary

Secret Referenceは以下を使えます。

```text
WP_MUSIC_PASSWORD
env:WP_MUSIC_PASSWORD
managed:bloggers/music/wp-password
```

managed backendはデプロイ環境側のESM moduleを起動時に読み込みます。

```bash
export BLOGGERS_SECRET_PROVIDER_MODULE=./deploy/secrets.mjs
```

moduleは `createSecretResolver({ env })` / `resolver` / `default` のいずれかをexportできます。起動時preloadは非同期で構いませんが、runtimeの`resolve(key)`は同期である必要があります。

AI / RBAC / Google OAuth / OIDCにもreference overrideを使えます。

```bash
BLOGGERS_ADMIN_TOKEN_REF=managed:bloggers/admin-token
BLOGGERS_AI_API_KEY_REF=managed:bloggers/ai/api-key
GOOGLE_REFRESH_TOKEN_REF=managed:bloggers/google/refresh-token
BLOGGERS_OIDC_CLIENT_SECRET_REF=managed:bloggers/oidc/client-secret
BLOGGERS_SESSION_SECRET_REF=managed:bloggers/session-signing-key
```

Secret Reference用フィールドへ実password/API keyらしいliteral値を書こうとするとStoreが永続化を拒否します。

## Browser identity — OIDC + HttpOnly Session

従来のBearer token RBACは維持しつつ、ブラウザ利用者はOIDCでログインできます。OIDCは未設定なら完全に無効です。

```bash
BLOGGERS_OIDC_ISSUER=https://idp.example.com
BLOGGERS_OIDC_CLIENT_ID=bloggers
BLOGGERS_OIDC_CLIENT_SECRET_REF=OIDC_CLIENT_SECRET
BLOGGERS_PUBLIC_BASE_URL=https://bloggers.example.com
BLOGGERS_SESSION_SECRET_REF=BLOGGERS_SESSION_SECRET

OIDC_CLIENT_SECRET='...'
BLOGGERS_SESSION_SECRET='32-bytes-or-longer-random-secret...'
```

Role mappingはIdPのclaimを**明示的にBloggers roleへ対応付ける**方式です。

```bash
BLOGGERS_OIDC_ROLE_RULES_JSON='[
  {"claim":"groups","value":"bloggers-admins","role":"admin"},
  {"claim":"groups","value":"bloggers-editors","role":"editor"},
  {"claim":"groups","value":"bloggers-viewers","role":"viewer"}
]'
```

ruleが1件も一致しないidentityはログイン拒否です。全IdPユーザーへroleを付けたい場合だけ`BLOGGERS_OIDC_DEFAULT_ROLE=viewer`等を明示します。

認証フロー:

```text
Browser
  ↓ /auth/login
Authorization Code + PKCE
  ↓ callback
state + nonce検証
  ↓
ID token JWKS署名検証
  ↓
issuer / audience / azp / exp / nbf / iat検証
  ↓
明示Role mapping
  ↓
HttpOnly signed Session
```

対応署名algは `RS256 / PS256 / ES256` です。JWKSは短時間cacheし、該当`kid`が見つからない場合は1回refreshしてkey rotationへ追従します。

SessionはHMAC署名し、credentialやID token/access token自体はCookieへ保存しません。productionではHTTPSを前提に`Secure`、flow cookieは`SameSite=Lax`、login後Sessionは`SameSite=Strict`です。

Cookie認証ではCSRFを別途防ぐ必要があるため、POST/PATCH等のSession mutationは**`Origin`が`BLOGGERS_PUBLIC_BASE_URL`のoriginと完全一致する場合だけ許可**します。

安全境界:

- OIDC有効時は開発用localhost-admin fallbackを使わない
- 明示Bearer tokenが送られた場合はBearerを優先し、不正Bearerを有効Sessionへfallbackしない
- `returnTo`は同一サイト内のrelative pathだけ許可し、open redirectを作らない
- OIDC discovery issuerは設定issuerと完全一致必須
- client secret / Session signing keyはSecret Resolverから取得

ローカルOIDC検証でHTTPが必要な場合だけ`BLOGGERS_OIDC_ALLOW_INSECURE_LOCALHOST=true`を明示してください。productionでは使用しません。

## Research / Citation / Quality Gate

Research Source本文は**未信頼データ**として扱います。

検査内容:

- 出典必須なのにsourceなし
- 不明なsource ID
- citation不足
- 数値・割合・日付claimと同一文のcitation
- citation先抜粋に主張した数値が存在するか
- 関連内部リンク候補

blocking issueがあればAutonomy Level 4以上でもHuman Gateへ降格します。Research fetchはpublic HTTP(S)のみを許可し、localhost/private network、redirect、過大responseを拒否します。

## AI Router / Cost Governor

OpenAI-compatible `/chat/completions` endpointを利用できます。Director / Writer / Reviserでモデルを分けられます。

```bash
BLOGGERS_AI_BASE_URL=https://provider.example/v1
BLOGGERS_AI_API_KEY_REF=managed:bloggers/ai/api-key
BLOGGERS_AI_MODEL=fallback-model
BLOGGERS_AI_DECIDE_MODEL=reasoning-model
BLOGGERS_AI_WRITE_MODEL=writing-model
BLOGGERS_AI_REVISE_MODEL=editing-model
```

実token usageから概算費用を記録し、cycle開始前だけでなく各AI callのusage保存直後にも月間reserveを再判定します。reserve到達はnon-retryableです。

API key未設定時は`RuleBasedProvider`でパイプラインを検証できます。

## Analytics / Learning

Analytics HubはCMS metrics + Search Console + GA4 + Custom HTTP Metricsを統合します。Google refresh後access tokenはmemory-onlyです。

CREATE / UPDATEが実際に反映された時点でExperimentを開始し、`positive / negative / inconclusive` の結果を評価します。完了した実測結果だけをBlog Memoryへ昇格し、次のDirector/Writer/Reviserへ戻します。

## RBAC

OIDCもBearer tokenも未設定の場合だけ、APIはlocalhost限定のadmin fallbackを使います。OIDCを有効化した時点でこのfallbackは無効です。

| Role | 主な権限 |
|---|---|
| viewer | HQ / Blogs / Content / Analytics / Activity / Settings閲覧 |
| editor | viewer + blog操作 / AI cycle / approval / Emergency Pause |
| admin | editor + Resume / AI予算 / Scheduler設定 |

従来の`BLOGGERS_ADMIN_TOKEN`はadmin互換です。RBAC tokenもenvまたはmanaged Secret Referenceで解決できます。

## アーキテクチャ

```text
                       Bloggers HQ / API
                              |
                 Token RBAC / OIDC Session
                              |
                       Storage Contract
                     /                   \
          JsonStore + fs lock      PostgreSQL runtime
                    |              /                \
               state.json    bloggers_state     jobs / leases
                                                SKIP LOCKED
                     \                   /
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

Write safety: Job lease + Operation lease → Connector side-effect fence
Secrets: env / managed resolver → no literal credential persistence
```

主要コード:

- `src/server.js` — HTTP/API/UI / auth route integration
- `src/auth.js` — viewer/editor/admin authorization policy
- `src/oidc.js` — OIDC discovery / PKCE / JWT/JWKS verification / signed Session
- `src/secrets.js` — env / managed Secret Resolver
- `src/worker.js` — standalone Worker
- `src/storage.js` — storage factory / pool module loader
- `src/store.js` — JsonStore
- `src/postgres-store.js` — PostgreSQL state / native jobs / leases
- `src/postgres-runtime-store.js` — PostgreSQL operation lease renewal
- `src/migrate-to-postgres.js` — JSON → PostgreSQL migration
- `src/jobs.js` — leased Job Queue
- `src/leases.js` / `src/runtime.js` — operation lease / exclusive runtime
- `src/execution-context.js` — nested side-effect fencing context
- `src/scheduler.js` — Scheduler / Worker loop
- `src/connectors.js` — Memory / WordPress / Ghost
- `src/orchestrator.js` — editorial loop
- `src/quality.js` — Research / Citation / Claim checks
- `src/analytics.js` / `src/experiments.js` — measurement / learning

## 次のproduction-hardening候補

- PostgreSQL driverの正式依存化（guard制約変更の承認後）
- blogs / articles / analytics / experiments等の段階的なPostgreSQL正規化
- OIDC Sessionのserver-side revocation / key rotation grace window
- AWS Secrets Manager / GCP Secret Manager / Vault等の具体provider module
- microCMS / Contentful等の追加Connector
- semantic / AI-assisted fact verification
- Google service account
- conversion / revenue中心のExperiment評価
- provider固有AI Adapter / pricing registry

## Guardrail

`AGENTS.md`、`docs/` の台帳、GitHub Actions guardを維持し、承認済みfeature IDの範囲だけを実装します。
