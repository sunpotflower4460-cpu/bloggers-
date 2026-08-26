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
2. that blog scope's daily call cap

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

When enabled, `/diagnostics` shows `AIブログ別日次call上限` with:

- budget day/timezone
- configured calls-per-blog limit
- current calls for the busiest blog scopes
- warning at 80% or more
- error when a scope reaches the cap

When the setting is empty, this diagnostic is omitted because F-038 is disabled.

## Why this is a hard cap while F-037 is not

F-037's observation flags only help a human notice unusual activity. They never stop work.

F-038 is different: it is an explicit operator-configured safety boundary. Reaching it prevents the **next AI outbound call for that blog** until the budget day changes or the operator changes/disables the cap. It does not automatically toggle the blog's `active` state, change publish mode, or reroute to another provider.

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

The incident closes when the current budget state is no longer exhausted. This can happen because:

- the `AI_BUDGET_TIMEZONE` day changed and the new day's blog counter is below the cap
- the operator raised `AI_PER_BLOG_DAILY_CALL_LIMIT`
- the scope has no calls in the current budget day
- the operator explicitly disabled the per-blog cap

When monitoring is explicitly disabled, the recovery detail says that monitoring was disabled and **does not claim AI usage itself fell**.

### Invalid configuration is not recovery

If `AI_PER_BLOG_DAILY_CALL_LIMIT` becomes malformed while an incident is OPEN, F-039 does not close it and does not emit a false RECOVERY. The per-blog reconcile step reports the configuration error while unrelated monitor checks continue.

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
- ホームはpersistent incidentを表示する層です。monitorがまだF-039 reconcileを実行していない瞬間状態を独自に推測してincident扱いにはしません
- 上限解消後にmonitorがincidentをCLOSEDへ更新すると、次のホーム表示から通常状態へ戻ります

## Why there is no per-blog token hard cap yet

A reliable token amount is normally known only after the provider returns the response. Pre-reserving an unknown per-blog token quantity would either under-protect or reject legitimate work using an arbitrary guess.

For now:

- global `AI_DAILY_TOKEN_LIMIT` remains the token safety ceiling
- per-blog F-038 is a deterministic pre-request **call** cap
- F-035/F-036 continue to expose per-blog token/cost usage for human observation

A future per-blog token policy should only be added if it can reserve a defensible upper bound without making provider-specific assumptions.
