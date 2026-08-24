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
- offsite backupを有効化している場合、その成功markerが古くなっていないか
- AI日次予算が上限へ到達していないか

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

## 3. AI日次予算ガード

放置運用でAI APIの再試行やブログ数増加による予期しない利用量増加を防ぐため、AIリクエスト前にSQLite-backedの日次予算を予約します。workerと手動実行が同時に動いても同じ日次カウンタを共有します。

既定値:

```env
AI_DAILY_CALL_LIMIT=100
AI_DAILY_TOKEN_LIMIT=2000000
AI_BUDGET_TIMEZONE=Asia/Tokyo
AI_MAX_OUTPUT_TOKENS=
```

- call上限はproviderがusage情報を返さなくても必ず機能します
- providerがResponses互換の`usage.input_tokens / output_tokens / total_tokens`を返す場合はtoken数も加算します
- APIへ送信を開始したrequestは、providerエラーや再試行になってもcallとして数えます
- `AI_API_KEY` / `AI_MODEL` 自体が未設定の場合はrequest予約前に失敗するためcallを消費しません
- callまたはtoken上限到達後は次のAI requestを発行しません
- `/diagnostics` は80%以上でwarning、上限到達でerrorを表示します
- 上限到達は `ai-budget-exhausted` critical incidentになり、Webhook設定済みなら通知されます
- 日付が切り替わって予算が復旧するとincidentは自動closeされ、RECOVERYを1回送ります

token上限はproviderがusageを返さない場合は観測できないため、call上限を無効化しないでください。`AI_MAX_OUTPUT_TOKENS` は使用中のResponses互換providerが対応している場合だけ設定します。

## 4. VPS全停止を外から検知する GitHub Actions monitor

同じDocker host自体が停止した場合、内部monitorも同時に停止するため自分自身から通知できません。

Blog Gardenには `.github/workflows/external-uptime.yml` があり、GitHub-hosted runnerから15分ごとに次を確認できます。

```text
https://<BLOG_GARDEN_DOMAIN>/api/health
```

有効化はGitHubの **Settings > Secrets and variables > Actions** で行います。

Repository Variables:

```text
BLOG_GARDEN_HEALTH_URL=https://blog.example.com/api/health
BLOG_GARDEN_UPTIME_WEBHOOK_KIND=auto   # optional: auto / slack / discord / generic
```

Repository Secrets:

```text
BLOG_GARDEN_UPTIME_WEBHOOK_URL=https://...   # optional
```

`BLOG_GARDEN_HEALTH_URL` が未設定の間、scheduled jobは安全にskipします。Webhookを設定しなくてもGitHub Issueが外部incident記録として残ります。

### 外部incidentの流れ

1. GitHub runnerが `/api/health` のHTTP 200かつ `{ "status": "ok" }` を期待する
2. 初回異常時だけ `[Blog Garden] External uptime incident` Issueを作成
3. Webhook設定済みならCRITICALを1回送信
4. 停止継続中は同じIssueを状態ストアとして使い、IssueやWebhookを増殖させない一方、workflow自体は失敗状態を維持する
5. 復旧確認時に同じIssueへ復旧コメントを追加
6. Issueを自動close
7. Webhook設定済みならRECOVERYを1回送信

health URLはHTTPSかつ `/api/health` を要求し、埋め込みユーザー名/パスワードを拒否します。Issue本文やWebhook本文へはquery stringを含むURLを出しません。

workflowは `contents: read` / `issues: write` の最小権限を明示しています。GitHub Actionsのrepository/organization policyがさらに厳しい場合は、Issue作成権限を許可してください。

### GitHub Actionsを外部監視に使う際の注意

GitHubのscheduled workflowは**default branchにworkflowファイルが存在する時だけ**動作します。そのため、このPRがfeature branchにある間はscheduleはまだ本番稼働しません。mainへ取り込まれた後に有効になります。

またGitHubのscheduleは厳密なリアルタイム保証ではなく遅延する場合があります。このworkflowは毎時0分を避け、`07 / 22 / 37 / 52`分に実行する設定です。

public repositoryでは、repository activityが60日間ない場合にscheduled workflowが自動無効化されることがあります。Blog Gardenを事業クリティカルに使う場合は、GitHub Actionsだけを唯一の外部監視にせず、別のmanaged HTTP uptime serviceも同じ `/api/health` へ向けて二重化してください。

## 5. ローカルSQLiteバックアップ

`backup` serviceは既定24時間ごとにSQLite online backupを作成し、`PRAGMA integrity_check`成功後だけ残します。

```env
BLOG_GARDEN_BACKUP_DIR=/mnt/separate-disk/blog-garden-backups
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_DAYS=30
```

primary named volumeと同じ物理ディスクだけに置くとhost故障には耐えないため、次のoffsite層を推奨します。

## 6. resticオフサイト暗号化バックアップ

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

## 7. 復旧優先順位

VPS障害時は次の順で復旧します。

1. GitHub external uptime Issueで外部から停止を確認
2. `APP_ENCRYPTION_KEY` を安全な別保管先から復元
3. restic repositoryから最新の検証済みSQLite backupを取得
4. 新VPSへBlog Gardenを配置
5. ローカル `backups/` へSQLite snapshotを置く
6. web / worker / backup / monitorを停止した状態で `CONFIRM_RESTORE=RESTORE` を使ってrestore
7. `/diagnostics` でDB、投稿先、Google、monitor、backup、AI予算を確認
8. `review` モードのブログから手動実行して投稿接続を確認
9. 問題なければ通常自動運転へ戻す
10. GitHub external uptime monitorが復旧を確認し、incident Issueを自動closeしたことを確認

## 8. 日常確認

通常は統合HP `/diagnostics` で以下だけ見れば十分です。

- SQLite: ok
- AI日次予算: ok
- 自動バックアップ: 36時間以内
- offsite backupを使う場合: 最新成功markerが36時間以内
- 独立monitor: 2時間以内
- open incidents: 0
- 障害通知Webhook: 設定済み
- 各platform接続: ok
- Search Console: 読み取り可

さらにGitHub側で `external-uptime` workflowが定期実行され、OPENの `[Blog Garden] External uptime incident` が存在しないことを確認します。

異常時は記事を増やす前に認証・AI予算・バックアップ・worker heartbeat・VPS到達性を先に直します。
