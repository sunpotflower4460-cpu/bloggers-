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

The execution is recorded as an `execution` log with status `ok` and the exact structured preflight reason. It is **not** recorded as an `editorial:error` just because a configured hard cap did its job.

Manual per-blog runs surface this as `AI予算上限で保護停止` instead of a generic retry error.

## What F-043 deliberately does not do

The preflight is advisory and does not replace the authoritative reservation inside `reserveAiCall()`.

A concurrent worker could consume the last available slot after preflight passes. Every actual outbound AI call must therefore still reserve inside the existing SQLite `IMMEDIATE` transaction immediately before the request. If that final reservation fails, the hard cap still wins.

F-043 also does not:

- raise any budget
- bypass a per-blog override
- switch providers to escape a cap
- modify the blog's `active` state
- change publish mode
- advance `lastRunAt` when a run is budget-blocked

Not advancing `lastRunAt` is intentional: a protected skip near the end of a budget day must not postpone the first eligible run of the next day by a full blog cadence interval.

## Configuration errors remain errors

Malformed safety configuration is not equivalent to a legitimately exhausted budget.

For example, an invalid `AI_PER_BLOG_DAILY_CALL_LIMIT` still causes the run to return `error`. This keeps broken operator configuration visible instead of silently downgrading it into a normal protected skip.

## Why analytics still run

AI spend protection and feedback collection are separate responsibilities. GA4/Search Console/native reactions do not consume the AI budget, and their data helps future editorial decisions after the budget resets. Stopping them solely because AI generation is capped would reduce the quality of the next healthy run.
