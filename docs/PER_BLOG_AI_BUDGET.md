# Per-blog AI daily call cap

F-038 adds an optional **blast-radius cap** inside the existing global AI budget so one blog cannot consume every shared call slot for the day.

## Configuration

Disabled by default:

```env
AI_PER_BLOG_DAILY_CALL_LIMIT=
```

Enable with a positive integer:

```env
AI_PER_BLOG_DAILY_CALL_LIMIT=20
```

The reset day uses the same `AI_BUDGET_TIMEZONE` as the global budget.

## Budget hierarchy

The existing global limits remain the final ceiling:

```env
AI_DAILY_CALL_LIMIT=100
AI_DAILY_TOKEN_LIMIT=2000000
AI_BUDGET_TIMEZONE=Asia/Tokyo
```

When the per-blog cap is enabled, an outbound request from `blog:<id>` must pass **both**:

1. the global daily call/token budget
2. that blog scope's effective daily call cap

The per-blog cap does not create extra allowance beyond the global budget.

## What counts

Every actual outbound AI reservation inside a blog execution counts, regardless of route:

- primary
- fallback
- economy
- a circuit-bypassed fallback
- a bounded recovery call after an economy/primary availability failure

This is deliberate. A blog that repeatedly needs a second provider call should not escape its blast-radius limit merely because those requests use different routes or models.

## Concurrency safety

The current blog call count is checked and incremented inside the same SQLite `IMMEDIATE` transaction used to reserve the outbound request. Two concurrent requests therefore cannot both observe the final free slot and overrun the cap.

If a reservation is rejected by the per-blog cap, that rejected request:

- is not sent to the provider
- does not increment the blog counter
- does not increment the global call counter

## Scope boundary

F-038 applies only to explicit `blog:<id>` AsyncLocalStorage scopes.

`system/unattributed` is intentionally outside this cap and remains governed by the existing global budget. This avoids a malformed optional blog-cap setting becoming a kill switch for unrelated system-level AI work.

An invalid configured value such as `abc`, `0`, a negative number, or an excessively large value is **not silently treated as unlimited** for blog calls. A blog-scoped reservation fails with a configuration error until the operator fixes the setting. `/diagnostics` also surfaces the configuration error.

## Diagnostics

When at least one shared or individual cap is active, `/diagnostics` shows `AIブログ別日次call上限` with:

- budget day/timezone
- shared/default cap when configured
- individual override count
- each visible blog scope's effective limit and whether it came from `共通` or `個別`
- warning at 80% or more
- error when a scope reaches its effective cap

If neither the shared cap nor any individual override exists, the diagnostic is omitted.

## Why this is a hard cap while F-037 is not

F-037's observation flags only help a human notice unusual activity. They never stop work.

F-038 is different: it is an explicit operator-configured safety boundary. Reaching it prevents the **next AI outbound call for that blog** until the budget day changes or the operator changes/disables the effective cap. It does not automatically toggle the blog's `active` state, change publish mode, or reroute to another provider.

## F-039: persistent exhaustion incident

A hard cap that silently blocks one blog is safe for cost control but weak for unattended operations. F-039 therefore reconciles a persistent incident for every exhausted `blog:<id>` scope.

Incident code:

```text
ai-per-blog-budget-exhausted
```

Behavior:

- first detected exhaustion opens one `warning` incident for that stable blog scope
- Slack / Discord / generic webhook receives one WARNING when configured
- repeated monitor runs reuse the same `(code, scope)` row and do not create duplicates
- a continuing warning is eligible for the normal 48-hour reminder cadence
- if the condition clears, the same row becomes CLOSED and one RECOVERY is sent
- if the same blog later exhausts again, that same row is reopened rather than inserted again

### Recovery cases

The incident closes when the current effective budget state is no longer exhausted. This can happen because:

- the `AI_BUDGET_TIMEZONE` day changed and the new day's blog counter is below the cap
- the operator raised the shared limit
- the operator raised or removed that blog's individual override
- removing an override makes the blog inherit a higher shared limit
- the scope has no calls in the current budget day
- both the shared limit and relevant overrides are explicitly disabled/removed

When monitoring is fully disabled, the recovery detail says that monitoring was disabled and **does not claim AI usage itself fell**.

### Invalid configuration is not recovery

If the shared setting or a persisted override becomes malformed while an incident is OPEN, F-039 does not close it and does not emit a false RECOVERY. The per-blog reconcile step reports the configuration error while unrelated monitor checks continue.

### Stable incident scope

The incident uses `blog:<id>` rather than the display name as its primary scope. This avoids collisions when two blogs share the same name or a blog is renamed. Human-readable blog labels remain in the incident detail.

## F-040: home dashboard visibility

Webhook通知を使わない運用でも、F-039で保護停止しているブログを見失わないよう、ホーム画面は`ai-per-blog-budget-exhausted`の**OPEN incidentだけ**を専用queryで読み取ります。

表示:

- 全体statsに現在の`AI上限停止`件数
- 対象ブログカードの状態を`自動運転`ではなく`AI上限で保護停止`と表示
- incident detailと最終更新時刻
- `/diagnostics`への確認導線

重要な境界:

- CLOSED incidentはホームへ表示しません
- unrelated incidentが多数あっても、直近N件の汎用一覧に依存せず対象codeを全件取得するため、停止ブログが押し出されません
- 表示のためにブログの`active`値を変更しません
- ホームはpersistent incidentを表示する層で、独自の別判定ロジックを持ちません
- F-039がincidentをCLOSEDへ更新すると、次のホーム表示から通常状態へ戻ります

## F-041: per-blog override

更新頻度や役割が異なる庭をすべて同じblast-radius枠へ押し込めないため、各ブログの設定画面から任意の個別上限を設定できます。

実効上限の解決順序は固定です。

```text
individual blog override
        ↓ if absent
AI_PER_BLOG_DAILY_CALL_LIMIT
        ↓ if absent
per-blog cap disabled for that blog
```

重要な意味:

- 設定画面の個別欄が空なら**共通上限を継承**します。空欄は「無制限」指定ではありません
- 個別overrideを削除すると、その時点の共通上限へ戻ります
- 共通envが空でも、個別overrideがあるブログだけF-038保護を有効にできます
- 個別overrideは共通値より低くも高くもできますが、global `AI_DAILY_CALL_LIMIT`を超える追加枠を作るものではありません
- 個別値も1〜100000の整数だけです
- 保存先はAI予算専用の`blog_ai_budget_overrides`で、記事/ブログ本体の編集設定と分離します
- persisted overrideが壊れている場合はfail-closedで、暗黙の無制限にはしません
- diagnosticsとF-039 incidentは同じ実効上限を使います
- incident detailには上限が`個別override`か`共通上限`かを残します

設定画面で個別値を変えてもブログの`active`、公開方針、AI routeは変更しません。

## F-042: settings-save immediate incident reconciliation

F-041の実効上限はAI call時点では即時に効きますが、F-039 incidentだけ次回monitorまで待つと、設定直後にホーム表示やWebhookが古いまま残る時間が生まれます。F-042はこのずれをなくします。

ブログ設定保存時の順序:

1. 個別overrideを永続化する
2. 同じF-039 `reconcileAiPerBlogBudgetIncidents()` をその場で実行する
3. 新しい実効上限でWARNING / RECOVERY / reopenを即時反映する
4. ホームはF-040の同じpersistent incidentを読むため、次の表示から同期した状態になる

例:

- すでに2 calls使ったブログへoverride `2`を保存 → その保存処理内でWARNINGをOPEN
- override `3`へ引き上げ → その場でRECOVERY
- override `1`へ下げる → 同じincident行をその場で再OPEN
- overrideを空欄へ戻し共通値`5`を継承 → その場でRECOVERY

安全境界:

- 即時reconcileは新しい判定方式ではなく、monitorと同じF-039関数を再利用します
- monitorが直後に走ってもincident/通知は重複しません
- Webhook送信失敗はSQLite incidentを失わせません
- overrideの永続化に成功した後、予期しないreconcile障害が起きても安全設定そのものは巻き戻しません。monitorが後続の再評価を引き継ぎます
- malformed共有設定などで完全なbudget snapshotを作れない場合は、既存OPEN incidentを誤ってRECOVERYにしません

## Why there is no per-blog token hard cap yet

A reliable token amount is normally known only after the provider returns the response. Pre-reserving an unknown per-blog token quantity would either under-protect or reject legitimate work using an arbitrary guess.

For now:

- global `AI_DAILY_TOKEN_LIMIT` remains the token safety ceiling
- F-038/F-041 are deterministic pre-request **call** caps
- F-035/F-036 continue to expose per-blog token/cost usage for human observation

A future per-blog token policy should only be added if it can reserve a defensible upper bound without making provider-specific assumptions.
