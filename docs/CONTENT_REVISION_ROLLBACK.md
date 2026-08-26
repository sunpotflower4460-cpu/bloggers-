# Autonomous content revision snapshots and rollback

F-051 adds a recovery line **before** Blog Garden expands autonomous existing-content changes beyond headline-only refreshes. F-052 closes the crash window where a durable `prepared` snapshot exists but the process stopped before Blog Garden could record whether the remote CMS mutation actually happened.

## Why the snapshot is prepared first

A remote WordPress/Ghost/Blogger mutation and the local SQLite write cannot be one atomic transaction. Blog Garden therefore writes a `content_revisions` row with status `prepared` **before** calling the external CMS.

The row stores:

- publication id
- mutation kind
- exact changed axes
- before snapshot: title / HTML / excerpt / platform updated timestamp
- intended after snapshot
- created time

Only after the CMS update succeeds is the revision marked `applied`. If the CMS call fails normally, the prepared row is marked `failed` rather than being presented as rollback-ready.

This ordering means an autonomous mutation never begins without durable rollback material already present locally.

## Current scope

F-051 is deliberately connected only to the existing autonomous Search Console headline refresh.

Current revision axes:

```text
headline
```

The snapshot stores body/excerpt too so the schema can support future safe expansion, but a current rollback sends **title only** to the CMS. It does not rewrite body or excerpt.

This preserves the one-variable experiment rule and prevents a headline rollback from overwriting later human body edits.

## Explicit rollback only

Applied revisions appear on `/` under `自動改善 · 戻せる変更`.

Rollback requires all of the following:

1. a human presses `変更前へ戻す`
2. the browser confirmation is accepted
3. `/api/revisions/rollback` receives `confirmRollback=true`
4. the revision is still `applied`
5. the publication is still published
6. the blog execution lease can be acquired
7. the external article is read again immediately before rollback
8. every changed axis still matches the revision's recorded **after** state

Only then does Blog Garden restore the recorded before value for the changed axis.

There is no automatic rollback based on analytics, AI judgment, an experiment outcome, or F-052 recovery monitoring.

## Human-edit collision safety

The current headline rollback compares the live external headline with the exact headline written by the autonomous refresh.

If they differ, rollback stops with a conflict. Blog Garden assumes a human or another process changed the headline after automation and refuses to overwrite it.

For future axes, collision checks are axis-specific:

- headline rollback compares headline
- body rollback would compare body
- excerpt rollback would compare excerpt

Fields outside the rollback axes are not overwritten.

Ghost still uses its latest `updated_at` requirement when applying the rollback mutation. WordPress and Blogger receive only the fields represented by the rollback axes.

## F-052: stale prepared reconciliation

A `prepared` row is normally short-lived. If it remains `prepared` for **15 minutes or more**, Blog Garden treats it as operationally uncertain: the process may have stopped before the remote request, after the remote request, or while final local bookkeeping was being written.

The independent monitor resolves only what can be proven from the current CMS state. It calls the platform adapter's **read** operation and compares the recorded changed axes against the revision snapshots.

```text
current CMS == BEFORE
  -> mark local revision failed
  -> no remote mutation is asserted

current CMS == AFTER (and differs from BEFORE)
  -> mark local revision applied
  -> reconcile local publication metadata
  -> revision becomes available through the normal explicit rollback path

current CMS != BEFORE and != AFTER
  -> keep revision prepared
  -> open CRITICAL content-revision-uncertain incident
  -> send normal configured Webhook notification
  -> wait for human inspection / a later safely identifiable state
```

If BEFORE and AFTER are observationally identical on the recorded axes, the monitor cannot prove a remote mutation occurred. It therefore resolves conservatively as `failed` / no asserted mutation rather than inventing an `applied` state.

A read/auth/network error also leaves the revision `prepared` and produces the same uncertainty signal. The monitor does not reinterpret an inability to read as success or failure.

### Read-only safety boundary

F-052 is **strictly read-only against the external CMS**. The reconciliation path never calls `updatePost`, never retries the abandoned autonomous mutation, and never performs rollback.

That boundary matters because a third state may be a legitimate human edit. Automatically forcing BEFORE or AFTER would destroy information precisely when Blog Garden knows least about what happened.

Once a later monitor pass can safely identify the live CMS state as BEFORE or AFTER, the revision is finalized and the `content-revision-uncertain` incident closes through the existing RECOVERY lifecycle.

F-052 runs even if the blog has since been paused, because uncertainty created by a previous external mutation must not disappear merely because future autonomous publishing was disabled.

## Operator visibility

The home keeps two revision areas deliberately separate:

- `自動改善 · 要確認revision`
  - `prepared` for 15+ minutes
  - recent `failed` revisions
  - inspection links only; no retry/rollback action
- `自動改善 · 戻せる変更`
  - only confirmed `applied` revisions
  - explicit collision-safe rollback action

`/diagnostics` also reports `既存記事revision整合性`:

- ERROR if one or more revisions have remained `prepared` for 15+ minutes
- WARN if there were failed revisions in the last 24 hours but no stale prepared rows
- OK when neither condition exists

The home retains recent failed revisions for seven days as audit/inspection context. A failed revision is not rollback-ready because Blog Garden does not claim that its intended remote mutation succeeded.

## State after rollback

After a successful external rollback:

- the revision becomes `rolled-back`
- it disappears from the rollback-ready queue
- the local publication title/url is reconciled
- the linked `content_refreshes` row receives `rolled_back_at`
- the linked headline experiment is excluded from the later 14-day outcome evaluation
- evaluated refresh learning excludes rolled-back experiments
- a `content-rollback` run log records the explicit operator action
- platform timestamps for apply and rollback remain separate audit fields

A rolled-back headline attempt still counts toward the existing 7-day/21-day refresh cooldown. This avoids an autonomous loop immediately reapplying another headline change after a human intentionally reverted one.

## Failure semantics

- CMS mutation failure before apply: revision becomes `failed`
- process crash + stale prepared + CMS still BEFORE: monitor marks `failed`
- process crash + stale prepared + CMS is AFTER: monitor recovers `applied`
- stale prepared + third state/read failure: remains `prepared`, CRITICAL incident
- rollback collision: revision stays `applied` and remains reviewable
- busy blog lease: rollback does not touch the CMS
- already rolled-back/non-applied revision: rollback request is rejected
- rollback endpoint without `confirmRollback=true`: request is rejected before any external mutation

The system never weakens platform collision behavior or guesses an uncertain remote state in order to make recovery appear successful.

## CI

`content-revision-rollback-smoke.ts` uses a local mock WordPress server and verifies F-051 and F-052 together:

- snapshot exists in `prepared` state before mutation
- applied revision enters rollback queue
- explicit rollback restores the original headline
- rollback request contains only `title`
- body and excerpt remain unchanged
- refresh is marked rolled back
- revision leaves rollback queue after success
- a later human headline edit blocks rollback
- conflicted revision remains `applied` and reviewable
- stale prepared + CMS BEFORE becomes `failed`
- stale prepared + CMS AFTER becomes `applied` and reconciles local publication state
- stale prepared + third state remains `prepared`, opens CRITICAL incident, and sends Webhook
- returning the third-state case to a safely identifiable BEFORE state produces RECOVERY
- monitor reconciliation performs zero CMS write requests
- home attention/rollback queues and diagnostics wiring remain present

CI never mutates a real external blog.
