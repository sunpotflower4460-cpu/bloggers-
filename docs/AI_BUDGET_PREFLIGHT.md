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

## What F-043/F-044 deliberately do not do

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
