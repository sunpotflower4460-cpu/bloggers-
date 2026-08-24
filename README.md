# Blog Garden

複数の外部ブログを、AI編集部がそれぞれ独立して育て続ける統合運用HPです。

## 目指す状態

初期設定でブログごとのテーマ・媒体・投稿頻度・情報源・公開方針を登録すると、以後は次のループを自動で回します。

1. トレンド / RSS / ニュースを収集
2. 過去記事と実績を見て、今書く価値が高い題材を選定
3. 媒体とブログ人格に合わせて記事を生成
4. WordPress / Ghost / Blogger に下書きまたは公開
5. GA4の実反応を回収
6. 伸びたテーマ・角度・タイトルを次回判断へフィードバック

統合HPでは、各ブログの稼働状態、最新投稿、PV、実行履歴をまとめて確認できます。

## 初期対応プラットフォーム

- WordPress REST API（Application Password）
- Ghost Admin API（Custom Integration）
- Blogger API v3（Google OAuth refresh token）

内部は `BlogPlatformAdapter` で分離しているため、将来ほかの媒体を追加できます。

## ローカル起動

```bash
cp .env.example .env
# ADMIN_PASSWORD / APP_ENCRYPTION_KEY / AI_* を設定
npm install
npm run dev
```

`http://localhost:3000/setup` で最初のブログを登録します。開発環境ではADMIN_*未設定でも起動できますが、productionでは未設定だと管理画面は503で閉じます。

## 常時運用

Docker Compose では Web と Worker が同じ SQLite volume を共有します。Worker は1時間ごとに起動し、各ブログの `cadenceHours` と `dailyLimit` を見て必要なブログだけを処理します。

```bash
docker compose up -d --build
```

## 必須環境変数

- `ADMIN_USERNAME` / `ADMIN_PASSWORD`: 統合HP/APIのBasic認証
- `APP_ENCRYPTION_KEY`: 64桁hex。ブログ資格情報のAES-256-GCM暗号化に使用
- `AI_API_KEY`: Responses API互換AIのキー
- `AI_MODEL`: 使用するモデル名
- `AI_BASE_URL`: 省略時 `https://api.openai.com/v1`

任意:

- `GOOGLE_SERVICE_ACCOUNT_JSON`: GA4 Data API用Service Account JSON。対象GA4 propertyにViewer権限を付与
- `DATABASE_PATH`: 省略時 `./data/blog-garden.sqlite`

## 自動公開の安全設計

ブログごとに `publishMode` を持ちます。

- `review`: 外部ブログに下書きとして送る
- `auto`: 自動公開する

資格情報はDBへ平文保存せず、`APP_ENCRYPTION_KEY` で暗号化します。AIには資格情報を渡しません。外部RSS/ニュースの文面はAIにとって信頼できない入力として区切り、そこに含まれる命令を無視するよう編集プロンプト側でも固定しています。

## 現在のフェーズについて

このリポジトリはGPT guardrail templateから開始しています。実装は `feat/autonomous-blog-garden` ブランチで進め、`PHASE.md` はテンプレート規約どおり変更していません。マージ前に人間が差分とフェーズを確認してください。
