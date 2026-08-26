# DECISIONS.md

| ID | 判断 | 採用 | 理由 |
|---|---|---|---|
| D-001 | 初期媒体 | WordPress / Ghost / Blogger | 公式の投稿APIと認証手段があり、自動化しやすい |
| D-002 | アプリ | Next.js + Node | 統合HPとサーバーAPIを1コードベースで持てる |
| D-003 | 初期永続層 | SQLite WAL | 1台Docker運用なら導入が軽く、workerとWebで共有可能 |
| D-004 | 資格情報 | AES-256-GCM暗号化 | DB流出時に外部ブログ資格情報を平文露出させない |
| D-005 | 情報収集 | Google News RSS + 任意RSS | 特定ベンダーAPIキーなしでも開始でき、ブログ別情報源も追加可能 |
| D-006 | 実反応 | GA4 Data APIの日次値 | 媒体横断でPV/セッションを同じ尺度にし、日次スナップショットの二重計上を防ぐ |
| D-007 | 自動運転 | 1時間worker + ブログ別cadence | 一律cronではなくブログごとの投稿ペースを維持できる |
| D-008 | 管理境界 | Next.js Proxy + Basic Auth | 外部公開時に設定・手動実行・資格情報登録画面を匿名アクセスさせない |
| D-009 | 外部テキスト | untrusted sourceとしてAIへ渡す | RSS本文に含まれるprompt injectionを編集命令として扱わない |
