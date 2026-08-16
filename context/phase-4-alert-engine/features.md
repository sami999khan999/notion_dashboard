# Phase 4 — Alert Engine + Email Channel — Features

> **Revised 2026-08-16.** Email-only, personal use. Rules E1–E9 replace A1–A7.

## What this phase delivers

After every cron tick, the Worker evaluates nine rules against the fresh D1
snapshot and emails you about anything new. Nothing is sent twice.

---

## Timer lifecycle — Time Tracker

### E1 · Timer started
The moment a Time Tracker row is seen with `Status = Running` and no `End Time`,
you get an email naming the activity, the linked task, and the local start time.

Fires once per timer row, on the transition into running — including the first
time the engine ever sees an already-running timer, so a mid-session deploy
doesn't leave you in the dark.

> **Latency: 30–90 seconds, and that is the floor.** Notion's
> `last_edited_time` has minute resolution and Cloudflare cron runs at most
> once a minute, so a timer started at 12:10:31 is invisible until the 12:11:30
> tick. Measured best case end-to-end: 26s. No amount of tuning beats this
> without webhooks, which Notion does not offer here.
>
> Emails within a tick are sent over **one batched SMTP session**. Previously
> each alert opened its own connection and paid the ~2s handshake, so a
> 20-block morning took ~40s to drain and invited Gmail's reconnect throttling.

### E2 · Still running, every 30 minutes
While a timer runs, you get a nudge at 30 minutes, 60, 90, and so on, showing
elapsed time. The interval is `ALERT_TIMER_TICK_MINUTES`.

Elapsed time is computed locally as `now − Start Time`, because Notion's
`Total Time In Seconds` reports **0** until the timer stops.

Only the current bucket is sent. If the Worker was down for two hours, you get
one email for the bucket you're in now, not four catch-up emails.

### E3 · Timer ended
When a running timer stops, you get a summary with the total duration and the
local start/end times.

---

## Deadlines — Tasks

Applies to any non-archived, non-completed task with a `Deadline`.

| Rule | When |
|---|---|
| **E4** | 24 hours before |
| **E5** | 1 hour before |
| **E6** | at the deadline |
| **E7** | after the deadline, still not completed |

**Mixed precision is handled.** A deadline stored as `2026-02-22` (date-only, no
time) means the whole day: it resolves to 23:59 local, E4 anchors to **09:00 the
previous day** rather than a useless midnight ping, and **E5 is skipped** — a
one-hour warning on a day-granularity deadline is noise.

**E7 (missed) re-nags once per day** by default, so an overdue task keeps
surfacing instead of vanishing after one email. `ALERT_DEADLINE_MISSED_RENAG=false`
makes it fire exactly once.

**Adding an old task won't spam you.** E4/E5/E6 are suppressed for deadlines more
than `ALERT_DEADLINE_STALE_HOURS` (24h) in the past, so importing a task with a
February deadline doesn't fire three emails at once. E7 still fires — that one is
the point.

> Only **3 of 359** tasks carry a deadline, and **all three are archived**, so
> this family is silent today — verified against the live D1 mirror. It starts
> doing work the moment a non-archived task gets a deadline.

---

## Daily Routine

### E8 · Block started
When local wall-clock enters a routine block's window, you get an email with the
activity and the window. **All 20 active blocks** are covered — including `Sleep`
at 02:00 and every `Break`.

Fires once per block per day.

**Computed locally, not read from Notion.** The `Active Now` formula returns
`"🟢 Active"` / `"🔴 Inactive"`, but Notion formulas don't bump
`last_edited_time` — the flip to Active produces no edit event and would never
reach an incremental sync. So the engine parses `Time` and `Days` itself and
evaluates them in `Asia/Dhaka`. That makes the trigger minute-exact, independent
of Notion's clock, and testable with a frozen `now`.

**Late-but-delivered.** A block fires if we're within 10 minutes of its start, so
a delayed cron tick still delivers. Beyond that it's dropped — deploying at 3pm
doesn't retroactively announce the morning.

**Midnight-safe.** The `23:55 – 00:00 Exercise` block observed at 00:02 is
correctly attributed to the previous day, for both the weekday check and the
dedupe key.

### E9 · Daily digest — *off by default*
One email listing the whole day's schedule, sent at `DIGEST_AT`. Available via
`ALERT_ROUTINE_DIGEST=true` if 20 per-block emails turns out to be too much.

---

## What you will actually receive

| Situation | Emails |
|---|---|
| A normal weekday (Sun–Thu), no timers | **20** — one per routine block |
| **Friday or Saturday** | **0** — every Fri/Sat routine row is archived |
| One 4-hour work session | **10** — start, 8 half-hour ticks, end |
| A task deadline, start to finish | **≤ 4**, plus one per day while overdue |
| Typical weekday with two long sessions | **~35–45** |

This is the configured behaviour, not an accident. Three levers if it's too much:

- Flip any rule off individually (`ALERT_ROUTINE_START=false`, etc.).
- Set `ALERT_QUIET_HOURS=00:00-07:45` to mute a local window — suppressed alerts
  are still logged with `status='suppressed'`, so nothing disappears silently.
- Switch to `ALERT_ROUTINE_DIGEST=true` and turn E8 off: 20 emails become 1.

---

## Delivery and bookkeeping

**Channel:** email only. Two interchangeable providers, chosen by
`EMAIL_PROVIDER`:

- **`smtp`** (default) — real SMTP over `cloudflare:sockets`. With a Gmail App
  Password this sends from your own mailbox to your own inbox: no third party,
  no domain, no API account.
- **`resend`** — Resend's HTTPS API. On the free tier `onboarding@resend.dev`
  sends to your own account address with no domain setup.

**Correction (2026-08-16):** earlier drafts of these docs claimed Workers cannot
open SMTP sockets. That is **wrong**. Cloudflare blocks outbound port **25** only
— submission ports **587 (STARTTLS)** and **465 (implicit TLS)** connect fine via
`cloudflare:sockets`, and `socket.startTls()` performs a real upgrade. Verified
from a deployed Worker against smtp.gmail.com: EHLO -> STARTTLS -> encrypted
EHLO advertising `AUTH LOGIN PLAIN XOAUTH2` -> `NOOP` 250.

What remains true: **Nodemailer does not work** — it needs `node:net`/`node:tls`
internals that nodejs_compat does not provide. So SMTP means speaking the
protocol directly (`src/alerts/smtp.ts`, ~170 lines).

**Dedupe:** every alert carries a `(rule, entity_id, threshold)` key. A condition
that stays true for 60 consecutive ticks sends one email, not 60. Recurring rules
put a date in the threshold so they re-arm the next day.

**Audit trail:** every candidate lands in `alert_log` with `sent`, `suppressed`,
or the error text. If an email didn't arrive, the log says why. Phase 5 surfaces
this as a "recent notifications" panel.

**Resilience:** a provider failure is logged and the alert is marked consumed,
so one outage costs one notification rather than triggering a retry loop. But an
**unconfigured** channel is different: the dispatcher bails before the dedupe
check, so missing secrets delay alerts rather than destroying them.

---

## Not in this phase

- **Push notifications / the Flutter app** — Phase 6, deferred. The `Alert` shape
  already carries everything a push would need, so reviving it changes one
  function.
- **Budget and focus-goal alerts** (the old A6/A7). Transactions and Goals are
  still synced and still shown on the dashboard; they just don't email.
- **Starting or stopping timers from the dashboard.** The `Start` / `Pause`
  buttons on Tasks are Notion `button` properties, which the API can neither read
  nor press. Replicating them means writing Time Tracker rows directly, which can
  drift from whatever the buttons do. The dashboard stays read-only; control
  stays in Notion.
