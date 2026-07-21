# Phase 4 — Alert Engine + Channels — Features

This document describes *what the alert engine does* in plain language. The type definitions, SQL, and code live in `implementation.md`.

## Where it runs

The alert engine is part of the single Cloudflare Worker. It executes inside the `scheduled()` cron handler, **after** Phase 3 has pulled Notion and upserted the D1 snapshot tables. The engine reads the just-written snapshot (so it always evaluates against the freshest data), plus the `goals` table, and it writes two tables: `alerts_sent` (for deduplication) and `alert_log` (for audit).

All alert code lives under `apps/worker/src/alerts/`.

## Core capabilities

### 1. A rule is a pure function

Every rule is a function of shape `(env) → Promise<Alert[]>` (rules query D1, so they are async, but they are otherwise *pure*: no dispatch, no writes, no mutation). A rule reads the snapshot, evaluates its condition, and returns a list of candidate `Alert` objects — one per entity that currently satisfies the condition. If nothing matches, it returns `[]`.

This purity is deliberate. It means:

- Rules are trivially unit-testable — seed rows, call the function, assert the returned array.
- Rules cannot accidentally double-send — they don't dispatch at all.
- The order rules run in doesn't matter (with the one documented exception of A4's dependency on Phase 3 timing).

### 2. The `Alert` shape

Every rule returns objects of a single shape:

```ts
{ rule, entityId, threshold, channel, title, body, html, notionUrl }
```

- `rule` — the rule id (`"A1"`…`"A7"`), part of the dedupe key.
- `entityId` — the id of the thing the alert is about (a timer id, task id, routine id, or a synthetic id like a goal/month key). Part of the dedupe key.
- `threshold` — a discriminator string that lets one rule fire at multiple tiers. For most rules it's a constant (e.g. `"1"`); for A6 it's `"80"` or `"100"`. Part of the dedupe key.
- `channel` — `"push"` or `"email"`.
- `title` / `body` — used by the push channel (and email subject).
- `html` — used by the email channel.
- `notionUrl` — deep link back to the relevant Notion page, passed as push data so tapping the notification opens the source.

### 3. The dispatcher with dedupe

`runAlertRules(env)` gathers candidates from all seven rules into one array, then for each candidate:

1. Checks `alerts_sent` for a row matching `(rule, entity_id, threshold)`.
2. If found, **skips** — this alert already fired in a previous (or the same) window.
3. Otherwise dispatches on the channel (`pushFcm` stub for push, `sendEmail` for email).
4. Calls `recordSent`, which writes **both** the `alerts_sent` dedupe row and the `alert_log` audit row.

This is what guarantees a rule that stays true for 60 minutes fires **once** rather than 60 times: the first tick records the dedupe row, and every subsequent tick sees it and skips.

### 4. Push channel (stub in this phase)

The primary channel is push to the Flutter app via FCM. In Phase 4, `pushFcm` is a **stub** that inserts a row into `alert_log` instead of calling FCM. This makes every push rule verifiable end-to-end without a phone — you assert on `alert_log`. Phase 6 replaces the stub body with a real FCM HTTP v1 call; nothing else changes.

### 5. Email channel (Resend HTTP API)

Cloudflare Workers cannot open raw SMTP sockets, so email is sent over HTTPS via the **Resend** API. `sendEmail(env, subject, html)` POSTs to `https://api.resend.com/emails` with the `RESEND_API_KEY` bearer token, using `ALERT_FROM` and `ALERT_TO` from env. Used by A5 and A6.

### 6. Audit logging

Every dispatched alert — push or email — produces one `alert_log` row (rule, entity_id, channel, message, status, sent_at). This is the source of truth for "what did the engine actually do", and it's what the Phase 4 tests assert against. Because the push channel is a stub that *only* writes `alert_log`, the audit trail doubles as the delivery record for this phase.

## The seven rules

Each rule below is described by **when it fires**, **why it matters**, and **its dedupe behavior**.

### A1 — Orphan timer (push, high priority)

**Source:** `timer_snapshot`. **Fires when:** a timer has `status = 'Running'`, its `start_time` is older than 3 hours, and `end_time` is empty. **Why it matters:** a timer left running is silently corrupting time-tracking data — you forgot to stop it, and every minute inflates the day's totals. High priority because the longer it runs the worse the data. **Dedupe:** keyed on the timer's `entity_id` with `threshold = "1"`, so one orphaned timer alerts once, not every tick, until it's stopped (which removes it from the condition).

### A2 — Task overdue (push)

**Source:** `task_snapshot`. **Fires when:** a task's `deadline` is before today, `completed = 0`, and `archived = 0`. **Why it matters:** the deadline has passed and the task isn't done — it needs attention or rescheduling. **Dedupe:** keyed on the task id. In this phase a given overdue task alerts once; Phase 7 adds TTL so it can re-alert on subsequent days.

### A3 — Deadline soon (push)

**Source:** `task_snapshot`. **Fires when:** a task's `deadline` is within the next 24 hours and the task is not completed. **Why it matters:** a heads-up before something is due, so it doesn't slip into overdue. **Dedupe:** keyed on the task id, so you get one "due soon" nudge per task rather than a nag every tick.

### A4 — Routine block starting (push, edge-triggered)

**Source:** `routine_snapshot`. **Fires when:** a routine's `active_now` transitions from `false` to `true` — i.e. exactly at the moment its scheduled block begins. **Why it matters:** it's the "start your focus block now" nudge; it must fire *once at the start*, not continuously while the block is active. **Dedupe / edge detection:** this rule is special. It compares the *incoming* `active_now` against the *previously stored* value (captured by Phase 3 before the upsert). It only emits an alert on the rising edge. Combined with the dedupe key it fires exactly once per block start.

### A5 — Routine missed (email digest)

**Source:** `routine_snapshot`. **Fires when:** at end-of-day, a routine scheduled for today (`today = 1`) was not completed (`done = 0`). **Why it matters:** a daily accountability summary of routines you planned but didn't do — delivered as an **email digest** rather than a push, so it's reflective rather than interruptive. **Dedupe:** keyed per routine per day (the day is encoded into the entity/threshold so a new day re-arms it).

### A6 — Budget threshold (push + email)

**Source:** `txn_snapshot` joined with `goals`. **Fires when:** the current calendar month's sum of `amount` where `type = 'Expense'` reaches **80%** or **100%** of the Expense Goal. **Why it matters:** early warning that you're burning through the month's budget, and a hard alert when you've blown it. **Two tiers:** the rule emits an independent candidate for `threshold = "80"` and for `threshold = "100"`. Because `threshold` is part of the dedupe key, each tier fires exactly once per month, and both can fire (80% earlier in the month, 100% later). This rule dispatches on **both** push and email.

### A7 — Focus goal (push)

**Source:** `timer_snapshot`. **Fires when:** by **21:00** (local), the sum of tracked seconds for today is below the daily focus target. **Why it matters:** an end-of-evening nudge that you're short of your focus target while there's still time to act. **Dedupe:** keyed per day, so it fires once on the evening it's true and re-arms the next day.

## Summary table

| # | Rule | Source | Channel | Dedupe discriminator (`threshold`) |
|---|------|--------|---------|-----------------------------------|
| A1 | Orphan timer | `timer_snapshot` | push (high) | `"1"` |
| A2 | Task overdue | `task_snapshot` | push | `"1"` |
| A3 | Deadline soon | `task_snapshot` | push | `"1"` |
| A4 | Routine block starting | `routine_snapshot` | push | `"1"` (edge-triggered) |
| A5 | Routine missed | `routine_snapshot` | email | date (`YYYY-MM-DD`) |
| A6 | Budget threshold | `txn_snapshot` + `goals` | push + email | `"80"` / `"100"` |
| A7 | Focus goal | `timer_snapshot` | push | date (`YYYY-MM-DD`) |
