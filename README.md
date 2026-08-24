# Blog Garden

複数の外部ブログを、AI編集部がそれぞれ独立して育て続ける統合運用HPです。

## 目指す状態

初期設定でブログごとのテーマ・媒体・投稿頻度・情報源・公開方針を登録すると、以後は次のループを自動で回します。

1. キーワードごとにトレンド / RSS / ニュースを収集
2. 重複を除き、鮮度・テーマ一致・ソース分散を加味して候補を整える
3. 過去記事のPV、前週比、エンゲージメント、コメント、Search Consoleの検索反応を見て今書く価値が高い題材を選定
4. 過去の編集実験結果を見て、今回検証する小さな仮説を1つだけ設定
5. 媒体とブログ人格に合わせて記事を生成
6. WordPress / Ghost / Blogger に下書きまたは公開
7. GA4・Search Console・媒体側の実反応を回収し、次回判断と次の実験へフィードバック

統合HPでは、各ブログの稼働状態、最新投稿、7日PV、前週比、エンゲージメント、コメント反応に加え、検索表示回数・クリック・CTR・平均順位・強い検索語もまとめて確認できます。

## 初期対応プラットフォーム

- WordPress REST API（Application Password）
- Ghost Admin API（Custom Integration / Admin API Key）
- Blogger API v3（Google OAuth refresh token）

内部は `BlogPlatformAdapter` で分離しているため、将来ほかの媒体を追加できます。

### 初期設定はJSON不要

`/setup` で媒体を選ぶと必要な項目だけが表示されます。

- WordPress: ユーザー名 + Application Password
- Ghost: Admin API Key (`id:secret`)
- Blogger: Blog ID + OAuth Client ID / Client Secret / Refresh Token

保存前に「接続テスト」で実際のAPIへ到達できるか確認できます。保存後も各ブログの「設定」から投稿頻度・公開方針・キーワード・RSS・GA4・Search Consoleを変更でき、資格情報は画面へ復号表示せず、入力し直した時だけ暗号化してローテーションします。

Search Console PropertyはSearch Consoleに表示されている文字列をそのまま使います。例:

- URL-prefix property: `https://example.com/`
- Domain property: `sc-domain:example.com`

設定画面の「Search Console接続テスト」で、保存前にservice accountの閲覧権限を確認できます。

## ローカル起動

```bash
cp .env.example .env
# ADMIN_PASSWORD / APP_ENCRYPTION_KEY / AI_* を設定
npm install
npm run dev
```

`http://localhost:3000/setup` で最初のブログを登録します。開発環境ではADMIN_*未設定でも起動できますが、productionでは未設定だと管理画面は503で閉じます。

## 常時運用

Docker Compose では Web と Worker が同じ SQLite volume を共有します。Worker は1時間ごとに起動し、各ブログの `cadenceHours` と `dailyLimit` を見て必要なブログだけを処理します。1日上限はブログに設定されたタイムゾーン基準で判定します。

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

- `GOOGLE_SERVICE_ACCOUNT_JSON`: GA4 / Search Console用Service Account JSON
  - GA4: service accountメールを対象propertyのViewerへ追加
  - Search Console: service accountメールを対象propertyのユーザーへ追加
  - Blog Gardenが要求するscopeは `analytics.readonly` と `webmasters.readonly` のみ
- `DATABASE_PATH`: 省略時 `./data/blog-garden.sqlite`

## 反応学習

GA4を設定したブログでは、前日のページ別 `screenPageViews` / `sessions` / `engagedSessions` を日次で蓄積します。編集判断では単純な累計PVだけでなく、直近7日と前7日の伸び、30日エンゲージメントも材料にします。

Search Consoleを設定したブログでは、確定データの遅延を考慮して3日前までの7日窓を取得し、記事別に次を保存します。

- clicks
- impressions
- CTR
- average position
- 上位検索query

Search Console APIは全検索行の完全取得を保証しないため、これらはアクセスログではなく「編集判断用の検索シグナル」として扱います。

さらに現在は次のネイティブ反応を収集できます。

- WordPress: 投稿ごとの承認済みコメント総数
- Blogger: 投稿リソースのコメント総数
- Ghost: 現時点ではGA4中心。未確認の非公式エンドポイントを推測して使いません

媒体固有の反応取得が失敗しても、その1件だけをスキップして編集ループ全体は継続します。

## 編集実験メモリ

各記事には、AI編集長が1つだけ小さな実験を割り当てます。変更可能な軸は `headline` / `angle` / `structure` のいずれか1つです。

実験には「variant」と「hypothesis」を保存し、その記事のPV・検索CTR・表示回数・平均順位・コメントと一緒に次回の企画時に読み返します。複数の要素を同時に変えて原因が分からなくなることを避け、1記事ずつ逐次的に学習します。実験は事実性・出典・読者価値を弱める方向には使いません。

## 自動公開の安全設計

ブログごとに `publishMode` を持ちます。

- `review`: 外部ブログに下書きとして送る
- `auto`: 自動公開する

資格情報はDBへ平文保存せず、`APP_ENCRYPTION_KEY` で暗号化します。AIには資格情報を渡しません。外部RSS/ニュースの文面はAIにとって信頼できない入力として区切り、そこに含まれる命令を無視するよう編集プロンプト側でも固定しています。

統合HPから各ブログを即時停止・再開できます。人間が明示的に「今すぐ育てる」を押した場合だけ投稿間隔・日次上限を越えた手動実行を許し、自動workerは設定上限を守ります。

## 現在のフェーズについて

このリポジトリはGPT guardrail templateから開始しています。実装は `feat/autonomous-blog-garden` ブランチで進め、`PHASE.md` はテンプレート規約どおり変更していません。マージ前に人間が差分とフェーズを確認してください。
