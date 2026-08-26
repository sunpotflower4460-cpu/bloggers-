# AI budget protected-run preflight

F-043 treats an already-exhausted AI budget as an expected protective operating state rather than repeatedly turning scheduled/manual runs into editorial errors.

## Where the preflight runs

A blog run still acquires its execution lease and collects non-AI feedback first:

- GA4
- Search Console
- due headline-refresh evaluations that do not call AI
- native comments/reactions

Immediately after those feedback collectors, Blog Garden runs the budget preflight **before**:

- AI-assisted published-headline refresh
- fresh trend/source collection for a new editorial cycle
- AI planning
- AI article generation
- publication caused by that generated article

This keeps the learning loop alive while avoiding editorial work that cannot legally obtain another AI reservation.

## Protected reasons

A run returns `budget-blocked` when one of these already holds:

- global daily call limit reached
- global daily token limit reached
- this blog's effective F-038/F-041 daily call limit reached

The first transition into that protected state is recorded as an `execution` log with status `ok` and the exact structured preflight reason. It is **not** recorded as an `editorial:error` just because a configured hard cap did its job.

Manual per-blog runs surface this as `AI予算上限で保護停止` instead of a generic retry error.

## F-044: transition-aware protected-skip log dedupe

An hourly worker can encounter the same expected protection many times before a daily budget resets. Writing an identical execution log every time creates noise without adding state information.

F-044 stores only the blog's current protected episode marker:

```text
blog_id -> budget day + protection reason
```

The marker is held in `ai_budget_preflight_state`, one row per blog. It does not replace the persistent F-039 incident or any AI usage row.

A new protected execution log is written when:

- the blog enters protection for the first time
- the protection reason changes, such as per-blog cap -> global cap
- the budget day changes while protection continues
- the blog previously passed a healthy preflight and later re-enters protection, even on the same day and for the same reason

A duplicate log is **not** written when:

- the same blog remains blocked
- on the same budget day
- for the same reason
- without a healthy preflight in between

Every run still returns `budget-blocked` to its caller. Only the repeated storage of an unchanged transition is deduped, so a manual request never loses its immediate response.

When a preflight is healthy, Blog Garden clears that blog's episode marker before normal editorial gating continues. This makes later same-day re-entry observable as a fresh transition.

The transition claim uses a SQLite `IMMEDIATE` transaction. The blog lease already serializes ordinary same-blog worker/manual execution, while the transaction prevents duplicate claims if future callers race outside that lease.

## F-045: current global protection on the home dashboard

A global call/token cap affects every garden, so waiting for an operator to open `/diagnostics` makes a whole-garden protection event too easy to misread as ordinary inactivity.

The home page therefore derives a banner directly from the same `aiBudgetStatus()` snapshot used by F-043. It does not maintain a second budget counter or wait for the monitor incident lifecycle.

When the current global hard cap is reached, the top of `/` shows:

- `庭全体のAI生成を保護停止`
- whether the reason is the call cap, token cap, or both
- current calls / call limit
- current total tokens / token limit
- budget day and `AI_BUDGET_TIMEZONE`
- a direct link to `/diagnostics`

The per-blog cards also stop saying `自動運転` while the global cap is active and instead show `庭全体AI上限で保護停止`. This is display-only: F-045 never changes the blog's stored `active` value or publish mode.

When neither global limit is reached, the banner is absent and normal card state returns immediately from the current budget snapshot. Per-blog F-039/F-040 incidents remain independent and can still be displayed for individual cap exhaustion.

## F-046: 80% global budget early warning

`/diagnostics` already treats global AI budget utilization of 80% or more as a warning. F-046 extends that same operational threshold to the persistent alert channel so unattended operation gets notice **before** the whole garden reaches the hard cap.

Incident codes remain intentionally separate:

```text
ai-budget-near-limit   # WARNING, 80% to below 100%
ai-budget-exhausted    # CRITICAL, 100% or above
```

Lifecycle rules:

- below 80%: neither incident is OPEN
- 80% to below 100%: `ai-budget-near-limit` is OPEN with WARNING
- repeated monitor runs do not duplicate the row or notification; WARNING reminders remain bounded to 48 hours
- 100% or above: near-limit WARNING is silently closed as superseded and `ai-budget-exhausted` becomes OPEN with CRITICAL
- the WARNING -> CRITICAL transition **does not emit a RECOVERY**
- if an operator raises the budget and utilization falls from 100% to a still-high 80–99%, CRITICAL is silently closed and WARNING reopens
- the CRITICAL -> WARNING downgrade **does not emit a RECOVERY**
- a genuine RECOVERY is sent only when utilization falls below 80%
- call and token utilization share the same threshold; whichever ratio is higher drives `budget.utilization`

The warning is advisory only. It never pauses work, changes provider routing, modifies a blog, or increases a budget. The existing hard-cap reservation remains the only mechanism that stops outbound AI calls.

## What F-043/F-044/F-045/F-046 deliberately do not do

The preflight is advisory and does not replace the authoritative reservation inside `reserveAiCall()`.

A concurrent worker could consume the last available slot after preflight passes. Every actual outbound AI call must therefore still reserve inside the existing SQLite `IMMEDIATE` transaction immediately before the request. If that final reservation fails, the hard cap still wins.

These features also do not:

- raise any budget
- bypass a per-blog override
- switch providers to escape a cap
- modify the blog's `active` state
- change publish mode
- advance `lastRunAt` when a run is budget-blocked
- suppress F-039 incidents or warning/recovery notifications

Not advancing `lastRunAt` is intentional: a protected skip near the end of a budget day must not postpone the first eligible run of the next day by a full blog cadence interval.

## Configuration errors remain errors

Malformed safety configuration is not equivalent to a legitimately exhausted budget.

For example, an invalid `AI_PER_BLOG_DAILY_CALL_LIMIT` still causes the run to return `error`. This keeps broken operator configuration visible instead of silently downgrading it into a normal protected skip. A configuration error also does not masquerade as a healthy preflight merely to clear protection state.

## Why analytics still run

AI spend protection and feedback collection are separate responsibilities. GA4/Search Console/native reactions do not consume the AI budget, and their data helps future editorial decisions after the budget resets. Stopping them solely because AI generation is capped would reduce the quality of the next healthy run.
