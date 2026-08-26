# INVENTORY.md

## 受入時点

- リポジトリは `GPT-template` から生成済み
- アプリ実装は未着手
- guard / human approval workflow / docs台帳 / craft資産が存在
- `PHASE.md` は P0 のまま

## 再利用するテンプレート資産

- `AGENTS.md`: スコープ逸脱防止
- `docs/00-soul`: プロダクトの核を固定
- `docs/01-intake`: ユーザー要求を原文保存
- `docs/02-decisions`: 技術判断と制約の追跡
- `docs/03-scope`: 実装対象IDの台帳
- `docs/04-design/tokens.css`: UI値の一元化
- `.github/workflows/guard.yml`: PR時の機械監査

## 新規実装予定

- Next.js統合ダッシュボード
- SQLite永続層
- 自律編集エンジン
- WordPress / Ghost / Blogger adapters
- RSS / Google News収集
- GA4 feedback loop
- 暗号化資格情報
- Docker常駐worker
