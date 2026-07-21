# Phase 2 — D1 Schema · Features

This phase ships no runtime behavior of its own. What it ships is the **data foundation**
every later phase builds on. Each table below is a capability: it exists so that some
downstream feature can be fast, correct, and independent of the Notion API.

## Capability 1 — Durable Notion mirror (dashboard reads never hit Notion)

The core architectural bet of the whole project: the dashboard should be instant and
should keep working even if Notion is slow, rate-limiting us, or briefly down. We achieve
that by mirroring the Notion databases we care about into local D1 snapshot tables. The
`scheduled()` cron refreshes them (Phase 3); the dashboard only ever reads from them.

The snapshot tables:

### `task_snapshot`
A local copy of the Notion **Tasks** database. One row per Notion task page
(`notion_id` = the Notion page id). Carries the fields the dashboard renders and the
alert engine evaluates: `title`, `status`, `deadline`, `completed`, `archived`,
`progress`, and `seconds_today` (time tracked today, aggregated by the sync). `updated`
is the Notion `last_edited_time`, used both for display and for incremental sync.

- **Dashboard** renders task lists, "due soon" and "overdue" views.
- **Phase 4 alerts** scan for tasks past `deadline` that are not `completed`/`archived`.

### `timer_snapshot`
A local copy of the Notion **Timers** database — running and historical time-tracking
entries. `task_id` links a timer back to a task (`task_snapshot.notion_id`). `status`
distinguishes running vs stopped; `start_time`/`end_time` bound the interval;
`total_seconds` is the computed duration.

- **Dashboard** shows the currently running timer and today's tracked time.
- **Phase 3** aggregates timers into `task_snapshot.seconds_today`.
- **Phase 4** can alert on a timer left running too long.

### `routine_snapshot`
A local copy of the Notion **Routines** database — scheduled recurring activities.
`activity` is the label, `time` the scheduled time-of-day, `date` the occurrence date,
`active_now` a flag for the current window, `done` a completion flag.

- **Dashboard** shows "what's active now" and the day's routine checklist.
- **Phase 4** can alert on a routine window that's active but not `done`.

### `txn_snapshot`
A local copy of the Notion **Transactions** (finance) database. `amount` is the raw
magnitude; `type` is income/expense; `signed` is the signed amount (income positive,
expense negative) precomputed by the sync so the dashboard and rules can just `SUM`.
`category`, `account`, and `month` (an `YYYY-MM` bucket) support grouping; `date` is the
transaction date.

- **Dashboard** renders spend-by-category, cashflow, and monthly rollups.
- **Phase 4 budget rule** compares `SUM(signed)` for a month against `goals_snapshot`.

### `goals_snapshot`
A local copy of the Notion **Goals** database — per-month budget targets. `income_goal`
and `expense_goal` are the monthly targets, keyed by `month` (`YYYY-MM`).

- **Phase 4 budget rule** joins monthly transaction totals against these targets to
  decide when to fire "over budget" / "income shortfall" alerts.

**Net effect:** every dashboard query is a local SQLite read. Notion latency and
availability are decoupled from the user experience.

## Capability 2 — Sync cursor persistence (`sync_state`)

A tiny key/value table (`key` PK, `value`, `updated_at`). It persists whatever state the
mirroring job needs between cron runs — most importantly the **incremental sync cursor**
and per-database watermarks (e.g. the last `last_edited_time` processed per Notion
database), plus bookkeeping like the last successful sync timestamp.

- **Phase 3** reads the cursor at the start of each `scheduled()` run so it only fetches
  Notion pages changed since last time, then writes the new cursor back. This keeps sync
  incremental and cheap instead of re-pulling everything every run.

Storing values as `TEXT` keeps it schema-agnostic — the sync can serialize whatever it
needs (a timestamp, a JSON blob) under a well-known key.

## Capability 3 — Alert dedupe keying (`alerts_sent`)

Alert rules run on every cron tick against the D1 snapshot. Without dedupe, a task that
stays overdue would generate an alert on **every** run. `alerts_sent` prevents that.

The composite primary key `(rule, entity_id, threshold)` is the dedupe key:

- `rule` — which rule fired (e.g. `task_overdue`, `budget_over`).
- `entity_id` — the specific entity (e.g. the task's `notion_id`, or a `YYYY-MM` for a
  budget rule).
- `threshold` — the condition window / bucket that was crossed (e.g. `due`, `24h`, or a
  month). This lets one entity legitimately alert again when it crosses a *new*
  threshold, while suppressing repeats within the same window.

Because the PK is composite, an `INSERT OR IGNORE` succeeds exactly once per
`(rule, entity_id, threshold)` combination. Phase 4 uses that: attempt the insert; if a
row was written, this is a new condition and we send; if it was ignored, we've already
alerted for this window and we stay quiet.

## Capability 4 — Audit log of every send (`alert_log`)

Where `alerts_sent` answers "have we already alerted?", `alert_log` answers "what did we
actually send, when, through which channel, and did it succeed?" It's an append-only
audit trail with an autoincrement `id`.

Columns: `rule`, `entity_id`, `channel` (e.g. `fcm`), `message` (the rendered body),
`status` (e.g. `sent`, `failed`), `sent_at`.

- **Phase 4** appends one row per delivery attempt.
- Useful for debugging ("why did I get pinged?"), for a future "recent alerts" view, and
  for observability on delivery failures.

## Capability 5 — Device token registry (`device_tokens`)

Stores the FCM (push) tokens that alerts are delivered to. `token` is the PK; `platform`
records the device type; `active` (default `1`) lets us soft-disable a token instead of
deleting it; `registered_at` and `last_seen` track lifecycle.

- **Phase 6** registers a device by upserting its token here.
- **Phase 4** selects `WHERE active = 1` to get the fan-out list of push targets.

Soft-deactivation matters: when FCM reports a token as stale/unregistered, we flip
`active = 0` rather than losing the historical record.

## How the tables fit together

```
        Notion                         D1 (mirror + bookkeeping)
  ┌──────────────┐   scheduled()   ┌───────────────────────────────┐
  │ Tasks        │ ───mirror────►  │ task_snapshot                 │
  │ Timers       │ ───mirror────►  │ timer_snapshot                │
  │ Routines     │ ───mirror────►  │ routine_snapshot              │
  │ Transactions │ ───mirror────►  │ txn_snapshot                  │
  │ Goals        │ ───mirror────►  │ goals_snapshot                │
  └──────────────┘                 │ sync_state  (cursor)          │
                                    ├───────────────────────────────┤
   alert engine reads snapshots ─► │ alerts_sent (dedupe)          │
                                   ►│ alert_log   (audit)           │
   push fan-out reads ───────────► │ device_tokens (targets)       │
                                    └───────────────────────────────┘
```

The snapshots are written by sync and read by everything; the bookkeeping tables are
written and read by the alert engine and device registration. All of it lives in one D1
database bound as `DB`.
