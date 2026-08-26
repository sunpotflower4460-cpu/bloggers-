# Blog Garden External Monitoring

Blog GardenはVPS内部の`monitor`だけに依存しません。productionでは次の2系統を併用できます。

1. **GitHub Actions pull monitor** — 外部から`/api/health`へ到達できるかを15分ごとに確認
2. **managed dead-man heartbeat** — Blog Garden側から成功pingが来なくなったことを別インフラが検知

片方は「外から見に行く」、もう片方は「中から定期的に生存報告する」方式なので、同じ故障モードへ依存しにくくなります。

## Dead-man heartbeatの設定

外部のheartbeat/dead-man監視サービスで、worker用とbackup用の2つのcheckを作成し、それぞれの秘密ping URLを`.env`へ設定します。

```env
EXTERNAL_WORKER_HEARTBEAT_URL=https://<external-monitor>/<secret-worker-ping>
EXTERNAL_BACKUP_HEARTBEAT_URL=https://<external-monitor>/<secret-backup-ping>
```

productionではHTTPS URLだけを許可します。URLに含まれるpath/query tokenは認証情報と同じ扱いにしてください。Blog GardenはURLそのものをstdout/stderr、diagnostics、incident本文へ表示しません。

heartbeat endpointからのHTTP redirectも追従しません。秘密ping URLが別hostへ転送されて漏れる事故を避けるためです。

## いつpingするか

### Worker

`src/cli/daily.ts`が`runGarden()`を最後まで完了した後だけworker heartbeatを送信します。

通常Docker構成ではworker loopは1時間ごとなので、外部サービス側の猶予は実行間隔より十分長くしてください。Blog Gardenの`/diagnostics`では最終成功から3時間を超えるとstale扱いを始めます。

記事が0件だった、またはその時間に投稿対象ブログがなかった場合でも、garden cycle自体が正常に完了していればpingします。これは「workerプロセスが生きて周期処理を完走した」ことを監視するためです。

### Backup

`src/cli/backup.ts`がSQLite online backupを作成し、さらに`PRAGMA integrity_check`が`ok`になった後だけbackup heartbeatを送信します。

既定backup周期は24時間です。`/diagnostics`では最終成功から36時間を超えるとstale扱いを始めます。壊れたbackupや途中失敗は成功pingになりません。

## 外部監視先が一時停止した場合

heartbeat deliveryの失敗は、worker処理や検証済みSQLite backupそのものを失敗扱いにはしません。監視サービスの障害によって本業まで止めないためです。

代わりにBlog Gardenは次を行います。

- `external_heartbeat_deliveries`へ最終成功/失敗を記録
- `/diagnostics`へworker/backupの外部heartbeat鮮度を表示
- 最新deliveryが失敗、または成功時刻が古い場合は内部monitorが`external-worker-heartbeat` / `external-backup-heartbeat` incidentをOPEN
- 通常の`ALERT_WEBHOOK_URL`が使える場合はwarning/criticalを通知
- deliveryが復旧するとincidentを自動CLOSEDし、RECOVERYを送信

workerは3時間超でwarning相当、6時間超でcritical相当、backupは36時間超/72時間超を目安にします。

## GitHub external uptimeとの役割分担

GitHub Actions monitorは`/api/health`を外から確認するため、DNS/TLS/Caddy/web/VPS全停止を広く検知できます。一方、dead-man heartbeatは周期workerやbackupが「成功地点まで到達しているか」を検知できます。

推奨形は次の3層です。

```text
Blog Garden internal monitor
        ↓
managed dead-man heartbeat  ← worker / verified backup success ping
        ↑
GitHub Actions /api/health monitor
```

VPS自体が停止すると内部monitorは止まりますが、GitHub Actionsとmanaged dead-man側は別インフラに残ります。GitHub Actions側に障害があってもmanaged dead-manが独立していれば、単一監視基盤への依存を減らせます。

## 復旧時の確認

障害復旧後は次を確認します。

1. `/api/health`がHTTP 200 / `status=ok`
2. workerが次のcycleを完走し、worker dead-manの最終成功が更新された
3. backupを手動または次周期で実行し、integrity check後のbackup dead-manが更新された
4. `/diagnostics`の外部dead-man項目が正常へ戻った
5. `external-worker-heartbeat` / `external-backup-heartbeat` incidentがCLOSEDになった
6. GitHub external uptime Issueが存在していた場合はRECOVERY後に自動closeされた

秘密ping URLが漏れた疑いがある場合は、外部監視サービス側でURL/tokenをローテーションし、`.env`も更新してください。
