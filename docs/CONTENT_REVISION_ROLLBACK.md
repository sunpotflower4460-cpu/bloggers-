# Autonomous content revision snapshots and rollback

F-051 adds a recovery line **before** Blog Garden expands autonomous existing-content changes beyond headline-only refreshes.

## Why the snapshot is prepared first

A remote WordPress/Ghost/Blogger mutation and the local SQLite write cannot be one atomic transaction. Blog Garden therefore writes a `content_revisions` row with status `prepared` **before** calling the external CMS.

The row stores:

- publication id
- mutation kind
- exact changed axes
- before snapshot: title / HTML / excerpt / platform updated timestamp
- intended after snapshot
- created time

Only after the CMS update succeeds is the revision marked `applied`. If the CMS call fails, the prepared row is marked `failed` rather than being presented as rollback-ready.

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

There is no automatic rollback based on analytics, AI judgment, or an experiment outcome.

## Human-edit collision safety

The current headline rollback compares the live external headline with the exact headline written by the autonomous refresh.

If they differ, rollback stops with a conflict. Blog Garden assumes a human or another process changed the headline after automation and refuses to overwrite it.

For future axes, collision checks are axis-specific:

- headline rollback compares headline
- body rollback would compare body
- excerpt rollback would compare excerpt

Fields outside the rollback axes are not overwritten.

Ghost still uses its latest `updated_at` requirement when applying the rollback mutation. WordPress and Blogger receive only the fields represented by the rollback axes.

## State after rollback

After a successful external rollback:

- the revision becomes `rolled-back`
- it disappears from the rollback-ready queue
- the local publication title/url is reconciled
- the linked `content_refreshes` row receives `rolled_back_at`
- the linked headline experiment is excluded from the later 14-day outcome evaluation
- evaluated refresh learning excludes rolled-back experiments
- a `content-rollback` run log records the explicit operator action

A rolled-back headline attempt still counts toward the existing 7-day/21-day refresh cooldown. This avoids an autonomous loop immediately reapplying another headline change after a human intentionally reverted one.

## Failure semantics

- CMS mutation failure before apply: revision becomes `failed`
- rollback collision: revision stays `applied` and remains reviewable
- busy blog lease: rollback does not touch the CMS
- already rolled-back/non-applied revision: request is rejected
- rollback endpoint without `confirmRollback=true`: request is rejected before any external mutation

The system never weakens platform collision behavior in order to make rollback succeed.

## CI

`content-revision-rollback-smoke.ts` uses a local mock WordPress server and verifies:

- snapshot exists in `prepared` state before mutation
- applied revision enters rollback queue
- explicit rollback restores the original headline
- rollback request contains only `title`
- body and excerpt remain unchanged
- refresh is marked rolled back
- revision leaves rollback queue after success
- a later human headline edit blocks rollback
- conflicted revision remains `applied` and reviewable

CI never mutates a real external blog.
