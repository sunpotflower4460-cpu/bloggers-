# Blog Garden

複数の外部ブログを、AI編集部がそれぞれ独立して育て続ける統合運用HPです。

## 目指す状態

初期設定でブログごとのテーマ・媒体・投稿頻度・情報源・公開方針を登録すると、以後は次のループを自動で回します。

1. キーワードごとにトレンド / RSS / ニュースを収集
2. 重複を除き、鮮度・テーマ一致・ソース分散を加味して候補を整える
3. GA4・Search Console・コメント反応を回収
4. 過去のタイトル改善が観測期間を満たしたら、CTR改善が本当に起きたかを保守的に評価
5. 検索表示は多いのにCTRが弱い既存記事があれば、安全条件の範囲でタイトル改善を優先
6. 改善候補がなければ、過去実績・編集実験・評価済み改善履歴を見て新記事の題材と小さな仮説を1つ選定
7. 媒体とブログ人格に合わせて記事を生成
8. WordPress / Ghost / Blogger に下書きまたは公開
9. 結果を次回判断・次の実験・既存記事改善へフィードバック

統合HPでは、各ブログの稼働状態、最新投稿、7日PV、前週比、エンゲージメント、コメント、検索表示回数・クリック・CTR・平均順位・強い検索語、現在の編集実験、最近の自動改善とその評価をまとめて確認できます。

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

Docker Compose では Web と Worker が同じ SQLite volume を共有します。Worker は1時間ごとに起動し、各ブログの `cadenceHours` を見て必要なブログだけを処理します。新記事の1日上限はブログに設定されたタイムゾーン基準で判定します。

```bash
docker compose up -d --build
```

Web側にはhealthcheckがあり、workerとbackup serviceはWebがhealthyになってから開始します。公開 `/api/health` はブログ名や件数などを返さず、最低限のlivenessだけ返します。

## 自動バックアップと復旧

Docker Composeでは既定で24時間ごとにSQLiteのオンラインバックアップを作成します。単純なファイルコピーではなくSQLiteのbackup APIを使い、作成直後に `PRAGMA integrity_check` が `ok` であることまで確認します。壊れたバックアップは残しません。

既定値:

- ホスト側保存先: `./backups`
- 間隔: 86400秒（24時間）
- 保持: 30日

`.env` で変更できます。

```env
BLOG_GARDEN_BACKUP_DIR=/mnt/separate-disk/blog-garden-backups
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_DAYS=30
```

primaryのDocker named volumeとは別のホストパスへ出すのが前提です。さらに重要な運用では、このディレクトリ自体を別マシン・NAS・暗号化クラウドストレージ等へ複製してください。

手動で1回だけ取得する場合:

```bash
npm run backup
```

### 復旧

DBにはブログ資格情報が暗号化された状態で入っています。**元と同じ `APP_ENCRYPTION_KEY` がなければ復旧後に資格情報を復号できません。** このキーはDBバックアップとは別のsecret manager等にも保管してください。

復旧は稼働中には行いません。まずサービスを止めます。

```bash
docker compose stop web worker backup
```

次に対象バックアップ名を指定し、明示確認文字列 `RESTORE` を渡した時だけ復旧します。復旧コマンドは対象バックアップを再度integrity checkし、現在のDBも `pre-restore-*.sqlite` として退避してから置換します。

```bash
docker compose run --rm --no-deps \
  -e CONFIRM_RESTORE=RESTORE \
  -e BACKUP_FILE=/backups/blog-garden-YYYYMMDD-HHMMSSZ.sqlite \
  backup ./node_modules/.bin/tsx src/cli/restore.ts

docker compose up -d
```

`docker compose down -v` はデータvolume自体を削除するため、復旧手順では使いません。

## 庭の健康診断

管理画面の `/diagnostics` から「庭全体を診断」できます。診断では記事の投稿・更新は行わず、次を確認します。

- `APP_ENCRYPTION_KEY` の形式
- AI key / model設定
- productionの管理画面認証
- SQLite読み取り
- 各ブログの投稿API接続
- Google service account設定
- Search Console propertyの実読み取り権限

自動運転が止まった時に「AIなのか、DBなのか、ブログ側認証なのか、Google権限なのか」を切り分けるための画面です。

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
- `BLOG_GARDEN_BACKUP_DIR`: Dockerホスト側のバックアップ保存先
- `BACKUP_INTERVAL_SECONDS`: 自動バックアップ間隔。既定86400
- `BACKUP_RETENTION_DAYS`: 保持日数。既定30

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
- Ghost: 現時点ではGA4 / Search Console中心。未確認の非公式コメントエンドポイントを推測して使いません

反応取得は最大4件ずつの小規模並列にし、BloggerのOAuth access tokenは有効期限内で再利用します。媒体固有の反応取得が1件失敗しても、残りの計測と編集ループは継続します。

## 編集実験メモリ

各新記事には、AI編集長が1つだけ小さな実験を割り当てます。変更可能な軸は `headline` / `angle` / `structure` のいずれか1つです。

実験には「variant」と「hypothesis」を保存し、その記事のPV・検索CTR・表示回数・平均順位・コメントと一緒に次回の企画時に読み返します。複数の要素を同時に変えて原因が分からなくなることを避け、1記事ずつ逐次的に学習します。実験は事実性・出典・読者価値を弱める方向には使いません。

## Search Console起点の既存記事改善

`auto` モードのブログでは、新記事を増やすだけでなく、検索上で芽が出ている既存記事を育て直します。現在の自動改善は原因を追いやすく安全性も高い「タイトルのみ」に限定しています。

候補条件は保守的です。

- 公開から7日以上
- Search Console impressions 50以上
- CTR 3.5%未満
- 平均順位1〜30位
- 1ブログにつき自動改善は最大週1回
- 同じ記事は21日以上空ける
- `review` モードでは公開済み記事を自動変更しない
- 人間が「今すぐ育てる」を押した手動実行では既存記事改善を挟まず、新記事作成を優先

検索queryはユーザー生成の非信頼入力としてAIへ渡し、query内の命令には従いません。AIには既存記事が裏付けていない数字・成果・煽り文句をタイトルへ追加させず、検索意図との整合と明確さだけを改善させます。

WordPressは既存post IDを更新、Ghostは最新postを取得して`updated_at`を添えて衝突検知付きで更新、BloggerはPATCH semanticsで変更フィールドだけを更新します。変更前タイトル・変更後タイトル・仮説・理由・日時はDBに残り、統合ダッシュボードにも直近の自動改善が表示されます。

### 改善結果の評価

タイトル変更から14日経つと、Search Consoleの確定7日窓が変更後だけで構成されるのを待ってから事後評価します。

- post-refresh impressionsが30未満 → `inconclusive`
- 平均順位が5位より大きく動いた → CTR変化に順位要因が混ざるため `inconclusive`
- それ以外でCTRが「最低0.5 percentage point、かつ元CTRの20%」の大きい方以上改善 → `win`
- 同じ幅以上悪化 → `loss`
- 変化が小さい → `inconclusive`

この判定は統合HPへ表示され、評価済みの改善履歴は次のタイトル改善・新記事企画へ戻されます。AI自身に成功判定をさせず、DB上の数値ルールで判定します。

## 自動公開の安全設計

ブログごとに `publishMode` を持ちます。

- `review`: 外部ブログに下書きとして送る
- `auto`: 自動公開する

資格情報はDBへ平文保存せず、`APP_ENCRYPTION_KEY` で暗号化します。AIには資格情報を渡しません。外部RSS/ニュースやSearch Console queryはAIにとって信頼できない入力として区切り、そこに含まれる命令を無視するよう編集プロンプト側でも固定しています。

統合HPから各ブログを即時停止・再開できます。人間が明示的に「今すぐ育てる」を押した場合だけ投稿間隔・日次上限を越えた手動実行を許し、自動workerは設定上限を守ります。

## 現在のフェーズについて

このリポジトリはGPT guardrail templateから開始しています。実装は `feat/autonomous-blog-garden` ブランチで進め、`PHASE.md` はテンプレート規約どおり変更していません。マージ前に人間が差分とフェーズを確認してください。
