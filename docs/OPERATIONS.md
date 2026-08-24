# Blog Garden Operations

長期自動運転向けの監視・通知・バックアップ運用です。

## 1. 独立monitor

`docker compose up -d` では `web` / `worker` / `backup` に加えて `monitor` が起動します。

monitorは既定1時間ごとに次を確認します。

- 稼働ブログがあるのにworker heartbeatが3時間以上更新されていない
- editorial処理が直近3回連続で失敗している
- Search Console設定済みブログで検索データ取得が直近3回連続失敗している
- GA4設定済みブログでanalytics取得が直近3回連続失敗している
- 各ブログの投稿API資格情報が現在も使えるか（6時間ごとにlive validation）
- 検証済みSQLiteバックアップが古くなっていないか

障害は `operational_incidents` に保存します。Webhook未設定でも履歴は失われません。

### 通知抑制

同じ障害を毎時間通知しません。

- 新規incident: 即時通知
- warning継続: 48時間ごとに再通知
- critical継続: 24時間ごとに再通知
- warning -> critical: 即時通知
- 復旧: `RECOVERY` を1回通知

## 2. Webhook通知

`.env`:

```env
ALERT_WEBHOOK_URL=https://...
ALERT_WEBHOOK_KIND=auto
MONITOR_INTERVAL_SECONDS=3600
```

`ALERT_WEBHOOK_KIND=auto` はURLからSlack/Discordを判別します。

- Slack: `{ "text": "..." }`
- Discord: `{ "content": "..." }`
- `generic`: `text / severity / code / scope / detail / at` のflat JSON

productionではWebhookはHTTPSのみ許可します。Webhook URL自体、ブログ資格情報、Google資格情報、AI API keyは通知本文へ出しません。エラー本文もtoken/password/secret等の典型パターンをredactして800文字までに制限します。

## 3. monitorで検知できない障害

同じDocker host自体が停止した場合、monitorも同時に停止するため自分自身から通知できません。

productionでは別系統の外部HTTP監視から次を監視してください。

```text
https://<BLOG_GARDEN_DOMAIN>/api/health
```

外部監視はBlog Gardenと同じVPSに置かないでください。

## 4. ローカルSQLiteバックアップ

`backup` serviceは既定24時間ごとにSQLite online backupを作成し、`PRAGMA integrity_check`成功後だけ残します。

```env
BLOG_GARDEN_BACKUP_DIR=/mnt/separate-disk/blog-garden-backups
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_DAYS=30
```

primary named volumeと同じ物理ディスクだけに置くとhost故障には耐えないため、次のoffsite層を推奨します。

## 5. resticオフサイト暗号化バックアップ

任意overlay `docker-compose.offsite.yml` は公式 `restic/restic:0.19.1` を使い、ローカルでintegrity check済みのSQLite snapshotディレクトリを別拠点へ暗号化保存します。

例:

```env
RESTIC_REPOSITORY=s3:s3.amazonaws.com/my-bucket/blog-garden
RESTIC_PASSWORD=<strong-independent-password>
OFFSITE_BACKUP_INTERVAL_SECONDS=86400
RESTIC_KEEP_DAILY=14
RESTIC_KEEP_WEEKLY=8
RESTIC_KEEP_MONTHLY=12
```

backendに応じて `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / SFTP設定等、resticが要求する環境変数を追加します。

起動:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.offsite.yml \
  up -d --build
```

`RESTIC_PASSWORD` は `APP_ENCRYPTION_KEY` と別の秘密値にしてください。両方をVPSだけに置くとVPS消失時に復旧不能になるため、secret manager等の別拠点に保管します。

## 6. 復旧優先順位

VPS障害時は次の順で復旧します。

1. `APP_ENCRYPTION_KEY` を安全な別保管先から復元
2. restic repositoryから最新の検証済みSQLite backupを取得
3. 新VPSへBlog Gardenを配置
4. ローカル `backups/` へSQLite snapshotを置く
5. web / worker / backup / monitorを停止した状態で `CONFIRM_RESTORE=RESTORE` を使ってrestore
6. `/diagnostics` でDB、投稿先、Google、monitor、backupを確認
7. `review` モードのブログから手動実行して投稿接続を確認
8. 問題なければ通常自動運転へ戻す

## 7. 日常確認

通常は統合HP `/diagnostics` で以下だけ見れば十分です。

- SQLite: ok
- 自動バックアップ: 36時間以内
- 独立monitor: 2時間以内
- open incidents: 0
- 障害通知Webhook: 設定済み
- 各platform接続: ok
- Search Console: 読み取り可

異常時は記事を増やす前に認証・バックアップ・worker heartbeatを先に直します。
