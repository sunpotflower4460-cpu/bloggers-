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

## Why there is no per-blog token hard cap yet

A reliable token amount is normally known only after the provider returns the response. Pre-reserving an unknown per-blog token quantity would either under-protect or reject legitimate work using an arbitrary guess.

For now:

- global `AI_DAILY_TOKEN_LIMIT` remains the token safety ceiling
- per-blog F-038 is a deterministic pre-request **call** cap
- F-035/F-036 continue to expose per-blog token/cost usage for human observation

A future per-blog token policy should only be added if it can reserve a defensible upper bound without making provider-specific assumptions.
