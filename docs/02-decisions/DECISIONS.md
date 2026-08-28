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
