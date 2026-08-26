# Task-aware AI Routing Policy

Blog GardenはAIの可用性・品質・コストを同じ1本のrouteで解決しません。役割を分離します。

## 3つのroute

### primary

通常の基準routeです。

- 最終記事本文
- 公開済み記事の改善案
- economy未使用時の内部企画

で使います。

### fallback

primaryのavailability障害を補うrouteです。

- bounded failoverは最大1回
- primary circuit open中はfallbackへ直接迂回
- 最終記事本文をfallbackが生成した場合は`AI_FALLBACK_CONTENT_POLICY`が適用
- 既定`review`ではauto記事もdraftへ降格
- 公開済み記事のfallback改善案は自動適用しない

fallbackは**障害対策**であり、安価な通常routeとしては扱いません。

### economy

F-031で追加した、低リスクな内部処理向けの任意routeです。

例:

- 収集済み候補からの題材選定
- angle / audience / editorial experimentの企画
- 読者へ直接表示されない内部JSON判断

現在のengineでは`choosePlan()`のように`aiJson()`を使う内部処理だけがeconomy対象です。

次はeconomy対象外です。

- 最終記事本文 (`aiJsonWithMeta`)
- 公開済み記事のheadline refresh案 (`aiJsonWithMeta`)
- 外部CMSへの公開権限判断

したがってeconomyを有効にしても、fallback reader-facing quality gateを迂回できません。

## 設定

既定は従来どおりprimaryです。

```env
AI_INTERNAL_ROUTE_POLICY=primary
```

economyを明示的に使う場合:

```env
AI_INTERNAL_ROUTE_POLICY=economy
AI_ECONOMY_MODEL=your-economy-model
AI_ECONOMY_PROVIDER_LABEL=economy
```

primaryと同じResponses-compatible API hostなら`AI_ECONOMY_BASE_URL`と`AI_ECONOMY_API_KEY`は省略できます。

別hostを使う場合:

```env
AI_ECONOMY_BASE_URL=https://economy-provider.example/v1
AI_ECONOMY_API_KEY=dedicated-key-for-that-provider
```

cross-host economyでは専用keyが必須で、`AI_API_KEY`と同じ値は禁止します。primary credentialを別providerへ転送しないためです。

## bounded recovery

economyを優先している内部リクエストでeconomy callが失敗した場合、通常routeへ最大1回だけ復帰します。

- primary circuit closed: economy -> primary
- primary circuit open: economy -> fallback

1論理リクエストの外向きcallは最大2回です。

economyがHTTP成功しても返したJSON内容が壊れていた場合は、別modelへ再生成しません。model/output品質問題をavailability障害として隠さず、追加コストも使わないためです。

## economy degradation incident

F-033では、economy最適化が壊れたまま通常route救済だけで処理が成功し続ける状態を検知します。

次の条件をすべて満たすと`ai-economy-degraded` warning incidentをOPENします。

- active blogが存在する
- `AI_INTERNAL_ROUTE_POLICY=economy`
- routing設定自体は有効
- economyの直近3試行がすべて`retryable_error`または`fatal_error`
- 3試行の最古が6時間以内

1〜2回の単発失敗ではincidentにしません。

このincidentはサービス停止を意味しません。economy失敗後にprimary/fallbackへbounded recoveryできている場合でも、**1論理処理に2 call使い続けてコスト最適化が逆効果になっている**ことを知らせる運用劣化です。

同じ障害は既存incident行を更新し、行を増殖させません。economyが次に成功するか、internal policyをprimaryへ戻すなど条件が解消すると同incidentをCLOSEDにし、Webhook設定済みならRECOVERY通知を送ります。

Blog Garden自身がこのincidentを理由に`AI_INTERNAL_ROUTE_POLICY`を変更することはありません。

## 予算

primary / fallback / economyの実callはすべて同じSQLite日次予算を消費します。

`AI_DAILY_CALL_LIMIT`と`AI_DAILY_TOKEN_LIMIT`をeconomyで迂回することはできません。

F-032ではmodel単位のusageも保存し、運用者が設定した単価表から参考コストを表示できます。詳細は`docs/AI_COST_ESTIMATION.md`を参照してください。

## observability

`/diagnostics`の`AI内部タスク経路`で次を確認できます。

- internal policy: primary / economy
- economy provider label / model
- 24時間のeconomy attempts / successes / failures
- 最終economy attempt

`ai_provider_attempts.route`では`primary`、`fallback`、`economy`を分けて記録します。そのため、意図的なeconomy利用がfallbackの障害統計・健全性判定を汚しません。

persistentなeconomy障害は通常のincident一覧にも`ai-economy-degraded`として表示されます。

## 運用ルール

- economyは必須ではありません。未設定なら従来挙動です。
- 実際の価格はBlog Gardenへハードコードしません。provider/modelの選択はオペレーターが行います。
- economyを読者向け最終生成へ拡大する場合は、別機能として品質評価・公開権限を再設計します。F-031の範囲では行いません。
