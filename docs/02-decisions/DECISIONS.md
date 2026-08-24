# DECISIONS.md

| ID | 判断 | 採用 | 理由 |
|---|---|---|---|
| D-001 | 初期媒体 | WordPress / Ghost / Blogger | 公式の投稿APIと認証手段があり、自動化しやすい |
| D-002 | アプリ | Next.js + Node | 統合HPとサーバーAPIを1コードベースで持てる |
| D-003 | 初期永続層 | SQLite WAL | 1台Docker運用なら導入が軽く、workerとWebで共有可能 |
| D-004 | 資格情報 | AES-256-GCM暗号化 | DB流出時に外部ブログ資格情報を平文露出させない |
| D-005 | 情報収集 | Google News RSS + 任意RSS | 特定ベンダーAPIキーなしでも開始でき、ブログ別情報源も追加可能 |
| D-006 | 実反応 | GA4 Data API | 媒体横断でPV/セッション/エンゲージメントを同じ尺度で扱える |
| D-007 | 自動運転 | 1時間worker + ブログ別cadence | 一律cronではなくブログごとの投稿ペースを維持できる |
