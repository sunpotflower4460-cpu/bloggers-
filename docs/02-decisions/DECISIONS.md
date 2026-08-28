# DECISIONS.md

ADR形式の追記ログ。新しい決定は末尾に追記する。

### D-001
- 日付: 2026-08-28
- 決定: プロダクトを単なる一括投稿ツールではなく「AI編集部OS」として実装する。
- 理由: ユーザーの目的が、AIが複数ブログへ接続し自動運用する統合HPだから。
- 根拠（Q-ID）: Q-001, Q-002
- 却下した案: 記事生成だけを中心にした単機能ツール。

### D-002
- 日付: 2026-08-28
- 決定: Portfolio Brain → Blog Brain → Agents の3層構造を採用する。
- 理由: ブログごとの文体・読者・戦略を分離しつつ、全体最適も可能にするため。
- 根拠（Q-ID）: Q-002
- 却下した案: 全ブログを1つの共通プロンプト・共通メモリで運用する構造。

### D-003
- 日付: 2026-08-28
- 決定: CMS接続はConnector interfaceで抽象化する。
- 理由: WordPress/Ghost/将来CMSを中核ロジックから分離して追加可能にするため。
- 根拠（Q-ID）: Q-002
- 却下した案: WordPress固有APIをアプリ全体へ直接埋め込む構造。

### D-004
- 日付: 2026-08-28
- 決定: 初期FoundationはNode.js標準ライブラリのみで起動可能にし、外部依存を追加しない。
- 理由: 既存guardrailの1PR新規依存0を維持しながら、実行可能な基盤を先に成立させるため。
- 根拠（Q-ID）: Q-002
- 却下した案: 最初のPRでNext.js/ORM/queue等を一括導入する。

### D-005
- 日付: 2026-08-28
- 決定: Search Console / GA4 / 任意HTTP MetricsをCMS metricsとは別のAnalytics Hubで統合する。
- 理由: CMS差異と分析サービス差異を分離し、観測できないsourceが1つあってもブログ運用全体を停止させないため。
- 根拠（Q-ID）: Q-002
- 却下した案: WordPress Connector内にGoogle Analytics処理を直接埋め込む。

### D-006
- 日付: 2026-08-28
- 決定: AIの施策はExperimentとしてbaselineと後続観測を記録し、結果だけをBlog Memoryへ昇格する。
- 理由: AIの思いつきをそのまま永続知識にせず、実測された学びを次の判断へ戻すため。
- 根拠（Q-ID）: Q-002
- 却下した案: 全AI出力をそのまま長期Memoryへ保存する。

### D-007
- 日付: 2026-08-28
- 決定: SchedulerはPortfolio Brainの優先順位でブログを実行し、個別失敗は再試行キューへ隔離する。
- 理由: 1ブログの外部API障害で他のブログ運用まで止まる構造を避けるため。
- 根拠（Q-ID）: Q-002
- 却下した案: 全ブログを固定順で実行し、1件失敗したら全サイクルを中断する。

### D-008
- 日付: 2026-08-28
- 決定: Research Sourceは公開HTTP(S)だけを許可し、localhost・private IP・private addressへ解決されるhostを拒否する。
- 理由: ユーザー入力URLをAI調査に利用しつつ、統合HPから内部ネットワークへ到達するSSRF経路を作らないため。
- 根拠（Q-ID）: Q-002
- 却下した案: 任意URLを制限なくfetchする。

### D-009
- 日付: 2026-08-28
- 決定: 引用必須設定で出典不足・不正なsource IDを検出した場合、Autonomy Level 4以上でも自動公開せずHuman Gateへ降格する。
- 理由: 自動化レベルより記事品質・検証可能性を優先し、AIが根拠を捏造した状態で公開しないため。
- 根拠（Q-ID）: Q-002
- 却下した案: 高Autonomyでは品質警告を無視して公開する。

### D-010
- 日付: 2026-08-28
- 決定: AIはDirector / Writer / Reviserでモデルをroutingでき、実token usageをAI Usage Ledgerへ保存して月間・サイクル予算で制御する。
- 理由: 強いモデルを必要箇所だけ使い、複数ブログ運用でAPI費用が無制限に膨らむことを防ぐため。
- 根拠（Q-ID）: Q-002
- 却下した案: 全処理を固定モデルで実行し、費用を外部請求画面だけで把握する。

### D-011
- 日付: 2026-08-28
- 決定: Schedulerの再試行正本をJSON-backed leased Job Queueへ移し、実行前にjobを永続化する。
- 理由: プロセス終了や再起動の途中でもJobを消失させず、lease期限切れ後に安全に再取得できるようにするため。
- 根拠（Q-ID）: Q-002
- 却下した案: メモリ上のtimerと一時retry配列だけに依存する。

### D-012
- 日付: 2026-08-28
- 決定: Google Search Console / GA4のaccess tokenはrefresh tokenから自動更新し、更新後tokenはメモリだけへキャッシュする。既存の直接access token環境変数は互換フォールバックとして残す。
- 理由: 長期自律運用で短命access tokenの手動更新を不要にしつつ、refresh後のcredentialをJSON永続化しないため。
- 根拠（Q-ID）: Q-002
- 却下した案: access token期限切れのたびに人間が環境変数を書き換える運用、または更新後tokenをstate.jsonへ保存する方式。

### D-013
- 日付: 2026-08-28
- 決定: ブログcycleと承認処理はJSON-backed operation leaseで排他し、API・Portfolio・Schedulerの入口を同じexclusive runtimeへ統一する。
- 理由: 手動実行とSchedulerの競合、ダブルクリック等で同じブログや承認を二重処理する事故を抑えるため。leaseには期限を持たせ、異常終了後は回収可能にする。
- 根拠（Q-ID）: Q-002
- 却下した案: 各入口ごとにメモリ上のbooleanだけで重複実行を防ぐ。

### D-014
- 日付: 2026-08-28
- 決定: CMS / Analytics / AI / OAuth / Researchの外部通信には用途別の有限timeoutを持たせる。
- 理由: 1つの外部サービスの無応答でcycle、operation lease、Scheduler全体が長時間占有されることを防ぐため。
- 根拠（Q-ID）: Q-002
- 却下した案: fetch既定の無期限待機に依存する。

### D-015
- 日付: 2026-08-28
- 決定: 出典必須の記事では、記事全体にcitationがあるだけでなく、数値・割合・日付等を含む検証可能なclaim単位で同じ文にcitationがあるか検査する。
- 理由: 記事末尾に出典一覧だけ置いて無関係な数値主張を通す事故を防ぎ、どの主張がどのSourceに依存するか追跡可能にするため。
- 根拠（Q-ID）: Q-002
- 却下した案: 本文中に1件でもcitationがあれば記事全体を検証済みとみなす。

### D-016
- 日付: 2026-08-28
- 決定: Cost Governorは各AI callのusage記録直後にも月間reserveを再判定し、reserveを跨いだcallを記録した上で同一cycleの追加AI callを停止する。予算到達はSchedulerでnon-retryableとする。
- 理由: Director callで残予算を使い切った直後にWriter/Reviserまで実行する超過と、月が変わるまで解消しない予算エラーの無意味な再試行を防ぐため。
- 根拠（Q-ID）: Q-002
- 却下した案: cycle開始時だけ予算確認し、途中超過を次cycleまで許容する。

### D-017
- 日付: 2026-08-28
- 決定: API認証はviewer / editor / adminの3段階token RBACを採用し、既存BLOGGERS_ADMIN_TOKENはadmin互換として残す。Emergency Pauseはeditor、ResumeとSettings変更はadminに限定する。
- 理由: 読み取り利用者・編集運用者・システム管理者を分離し、統合HPを複数人で使う際の権限過多を抑えるため。
- 根拠（Q-ID）: Q-002
- 却下した案: 全利用者が同一admin tokenを共有する方式。

### D-018
- 日付: 2026-08-28
- 決定: credential値は共通Secret Reference Resolver経由で取得し、永続化フィールドには環境変数名等のreferenceだけを許可する。Secret Reference用フィールドへliteral secretが入った場合はJsonStoreが保存を拒否する。
- 理由: WordPress / Google / Analytics / RBAC / AIの秘密値をstate.jsonへ誤保存する経路を減らし、将来のmanaged Vault backendへ差し替えやすくするため。
- 根拠（Q-ID）: Q-002
- 却下した案: 各moduleがprocess.envを個別に読み、設定APIから渡された値を無検証でJSON保存する方式。

### D-019
- 日付: 2026-08-28
- 決定: Connector LayerへGhost Admin API adapterを追加し、Custom Integration Admin API keyから有効期間5分のHS256 JWTを都度生成する。Ghost更新・公開は毎回最新postを取得し、collision detection用のupdated_atを送る。
- 理由: 複数ブログ統合OSをWordPress専用にせず、CMS差異をConnectorへ閉じ込めたままGhostも同じCREATE / UPDATE / PUBLISHパイプラインへ載せるため。
- 根拠（Q-ID）: Q-002
- 却下した案: Ghost専用の別運用フローを作る、Admin API keyをstate.jsonへ保存する、updated_atを再取得せず上書きする方式。

### D-020
- 日付: 2026-08-28
- 決定: JsonStoreのmutationをfilesystem lockでプロセス間排他し、atomic renameとowner付きstale-lock回収を組み合わせる。Job dedupeはqueuedだけでなくrunningもactiveとして扱う。
- 理由: Webとstandalone Worker、または複数Workerが同一state.jsonを共有してもlost updateや同一Job重複を起こしにくくするため。
- 根拠（Q-ID）: Q-002
- 却下した案: Nodeプロセス内Promise queueだけで排他できているとみなし、複数processから同じJSONへ直接書き込む方式。

### D-021
- 日付: 2026-08-28
- 決定: Schedulerはembedded / external workerを切り替え可能にし、Storageは共通contractへ寄せる。PostgreSQLは新規npm依存0制約を守るためdriverを同梱せず、pool injection型PostgresStoreとmigrationを先に実装する。
- 理由: 現在のFoundationを壊さずWebと自律実行を分離し、将来driver導入時にPostgreSQLのSELECT FOR UPDATE transactionへ移行できるようにするため。
- 根拠（Q-ID）: Q-002
- 却下した案: 制約を無視してpg/ORMを追加する、またはPostgreSQL移行時にOrchestrator/Job/Lease全体を書き直す方式。

### D-022
- 日付: 2026-08-28
- 決定: PostgreSQLではJob Queueとoperation leaseをstate documentから先に正規化し、Job取得はFOR UPDATE SKIP LOCKED、active dedupeはqueued/runningを対象とするpartial unique index、operation leaseはlease_key一意制約で裁定する。
- 理由: 複数Workerがglobal state rowを取り合わず別Jobを並列取得でき、同一Job・同一blog cycleの二重実行をDBのtransaction境界で抑えるため。
- 根拠（Q-ID）: Q-002
- 却下した案: PostgreSQLへ移行してもjobs/locksをglobal JSON document内だけに残し、全Workerが1行のSELECT FOR UPDATEを奪い合う方式。

### D-023
- 日付: 2026-08-28
- 決定: 新規npm依存0を維持したままPostgreSQL runtimeへ接続するため、デプロイ環境が提供するpool moduleをBLOGGERS_POSTGRES_POOL_MODULEからdynamic importする。JSON→PostgreSQL移行は明示コマンドとし、running Jobはqueuedへ戻し旧operation leaseは破棄する。
- 理由: driverを勝手に追加せず実運用への接続点を作りつつ、旧processのlease ownershipを新環境へ持ち込む危険を避けるため。
- 根拠（Q-ID）: Q-002
- 却下した案: pgを無断で依存追加する、running leaseをそのままコピーする、起動時に暗黙の破壊的migrationを行う方式。
