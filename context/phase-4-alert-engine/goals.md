# Phase 4 — Alert Engine + Email Channel — Goals

> **Revised 2026-08-16.** The plan changed: this is now a **personal, single-user**
> tool, and **email is the only notification channel**. Push/FCM and the Flutter
> app (Phase 6) are deferred, not deleted. The rule set was rewritten around
> timer lifecycle, task deadlines, and routine block starts. The previous
> A1–A7 rules (orphan timer, budget threshold, focus goal) are superseded.
>
> Read `context/notion-schema.md` before this file — it is the verified property
> reference and it corrects several errors the old rule set was built on.

## Objective

Turn each cron tick into **de-duplicated email notifications** across three
domains: the Time Tracker timer lifecycle, Task deadlines, and Daily Routine
block starts.

Each rule stays a **pure function** `(snapshot, now) → Alert[]` — no network, no
mutation, fully testable by seeding rows and asserting output. Dedupe, dispatch,
and audit logging live in one dispatcher (`runAlertRules`).

One channel ships: **email**, with two interchangeable providers selected by
`EMAIL_PROVIDER` — **`smtp`** (default, via `cloudflare:sockets`) and
**`resend`** (HTTPS API).

**Correction (2026-08-16):** earlier drafts of these docs claimed Workers cannot
open SMTP sockets. That is **wrong**. Cloudflare blocks outbound port **25** only
— submission ports **587 (STARTTLS)** and **465 (implicit TLS)** connect fine via
`cloudflare:sockets`, and `socket.startTls()` performs a real upgrade. Verified
from a deployed Worker against smtp.gmail.com: EHLO -> STARTTLS -> encrypted
EHLO advertising `AUTH LOGIN PLAIN XOAUTH2` -> `NOOP` 250.

What remains true: **Nodemailer does not work** — it needs `node:net`/`node:tls`
internals that nodejs_compat does not provide. So SMTP means speaking the
protocol directly (`src/alerts/smtp.ts`, ~170 lines).

## The rule set

| # | Rule | Source | Trigger | Dedupe threshold |
|---|---|---|---|---|
| **E1** | Timer started | Time Tracker | row observed with `Status = Running` and no `End Time`, not seen before | `start` |
| **E2** | Timer still running | Time Tracker | every 30 min of elapsed time while running | `30m`, `60m`, `90m`, … |
| **E3** | Timer ended | Time Tracker | `Running → Stoped`, or `End Time` becomes set | `end` |
| **E4** | Deadline in 24h | Tasks | `Deadline − now ≤ 24h`, not completed, not archived | `24h` |
| **E5** | Deadline in 1h | Tasks | `Deadline − now ≤ 1h`, not completed, not archived | `1h` |
| **E6** | Deadline reached | Tasks | `now ≥ Deadline`, not completed, not archived | `hit` |
| **E7** | Deadline missed | Tasks | `now ≥ Deadline + grace`, still not completed | `missed:<YYYY-MM-DD>` |
| **E8** | Routine block started | Daily Routine | local wall-clock enters a block's window | `<YYYY-MM-DD>T<HH:MM>` |
| **E9** | Daily routine digest | Daily Routine | once per day at `DIGEST_AT` | `<YYYY-MM-DD>` |

**E7 is enabled by default** (`ALERT_DEADLINE_MISSED=true`). It was named in the
original brief ("approaches and hits and misses") but not picked in the follow-up
options round, so it is a single var away from off. Its threshold includes the
date so an overdue task re-nags once per day rather than once ever — set
`ALERT_DEADLINE_MISSED_RENAG=false` to fire exactly once instead.

**E9 is disabled by default** (`ALERT_ROUTINE_DIGEST=false`). The chosen routine
behaviour is per-block emails for all 20 blocks; the digest is available if the
per-block volume turns out to be too much.

### Runtime configuration

Every value in the table above is **editable at runtime** from `/settings`, with
no redeploy. The `wrangler.jsonc` vars are the defaults; a row in the `settings`
D1 table overrides one, and `runAlertRules` resolves the merged config once per
tick. Deleting the overrides restores the deployed defaults exactly.

Rules receive a typed, pre-validated `AlertConfig` rather than raw env strings —
no rule parses a string, so a malformed stored value can never reach the alert
logic. Validation runs on read as well as on write, because D1 rows can be
edited outside the UI.

## Volume, stated plainly

With the current data — 20 active routine blocks, Sun–Thu only, 3 tasks with
deadlines — steady-state volume is:

- **20 emails/weekday** from E8, including `Sleep` at 02:00 and six `Break` blocks.
- **0 emails Fri/Sat** — every Friday and Saturday routine row is archived.
- **~2 + 2⌊h⌋ emails per tracked session** from E1/E2/E3 (start, end, and one per
  30 minutes). A 4-hour work session sends 10 emails.
- **≤ 4 emails per task with a deadline**, one-off, plus one/day while overdue.

A normal weekday with two long work sessions lands around **35–45 emails**. This
is the explicitly chosen behaviour ("All 20 blocks"), not an accident — but it is
worth knowing before you point it at an inbox you read. Every rule is
individually switchable by env var, and `ALERT_QUIET_HOURS` can suppress a local
time window without changing any rule code.

## Scope

In scope:

- The `Alert` type and nine pure rule functions (E1–E9).
- `runAlertRules` dispatcher with dedupe against `alerts_sent`.
- `recordSent` writing `alerts_sent` (dedupe key) and `alert_log` (audit trail).
- `sendEmail` with a provider switch (SMTP over `cloudflare:sockets`, or the Resend HTTP API) and an HTML template per rule family.
- **Local computation of routine windows** from `Time` + `Days` + `ALERT_TZ` —
  *not* from Notion's `Active Now` formula (see below).
- Timer state transition detection using the previous snapshot row.
- Per-rule enable/disable vars and a quiet-hours window.
- Local test harness: seed snapshot rows, run the engine, assert `alert_log`.

Out of scope (deferred):

- FCM push and the Flutter app → **Phase 6**, deferred indefinitely.
- Transactions / Goals budget rules — the old A6/A7. Those databases are still
  synced and still shown on the dashboard; they just no longer alert.
- Dedupe TTL / pruning semantics → **Phase 7**.
- Writing to Notion (starting/stopping timers from the dashboard) — see
  `notion-schema.md` §6 on why `Start`/`Pause` buttons are unreachable.

## The constraint that shapes this phase

**Notion formulas do not bump `last_edited_time`.** `Active Now` flips from
`"🔴 Inactive"` to `"🟢 Active"` at 09:00 with no edit event, so an incremental
`last_edited_time` pull will never surface it. An edge-triggered alert built on
that formula **would silently never fire**.

Therefore E8 computes block windows itself:

```
for each non-archived routine row:
    if localWeekday(now, ALERT_TZ) ∈ row.Days:
        parse "HH:MM - HH:MM" from row.Time
        if now crossed the start boundary within this tick → fire
```

This is deterministic, minute-exact, independent of Notion's clock, and unit
testable with a frozen `now`. It also means routine needs no incremental cursor —
20 rows is one cheap unfiltered query per tick.

The same reasoning applies to `Total Time In Seconds`, which is **0 while a timer
runs** (the formula guards on `End Time` being present). E2's elapsed time is
computed as `now − Start Time` locally.

## Exit criteria

1. **All 9 rules implemented as pure functions**, each `(snapshot, now) → Alert[]`,
   no side effects.
2. **Dedupe prevents double-send across ticks.** A condition true for 60
   consecutive ticks fires once per threshold, not 60 times.
3. **E8 fires once per block per day, at the right local minute.** With `now`
   frozen to `09:00 Asia/Dhaka` on a Monday, exactly the `09:00 - 13:00 Work`
   block fires. At `09:01` nothing fires. **A UTC-interpreted run must fail this
   test** — that is the regression guard for the six-hour timezone bug.
4. **E2 buckets correctly.** A timer started 95 minutes ago has fired `30m`, `60m`
   and `90m` exactly once each, and not `120m`.
5. **E5 is skipped for date-only deadlines.** `Deadline = "2026-02-22"` (length 10,
   no time component) produces E4/E6/E7 candidates but never E5.
6. **E1/E3 fire on transitions, not states.** A timer already running when the
   engine first sees it fires E1 once; it does not re-fire on subsequent ticks,
   and E3 fires exactly once when it stops.
7. **Every dispatched candidate produces exactly one `alert_log` row** and one
   `alerts_sent` row. Re-running the tick unchanged produces no new rows.
8. **Fri/Sat produce zero routine emails** given the current archived data.

Acceptance test: seed local D1 so each rule's condition is true, invoke
`scheduled()` with a frozen clock, assert one `alert_log` entry per
rule/entity/threshold, re-invoke, assert no new rows.

## Dependencies

- **Phase 2 — D1 schema.** Snapshot tables, `alerts_sent`, `alert_log`.
  Phase 4 adds a `notified_bucket` column to `timer_snapshot` (see
  `implementation.md`) so E2 survives a Worker restart.
- **Phase 3 — sync pipeline.** Must expose the **previous** `timer_snapshot` row
  (status + end_time) captured *before* upsert, so E1/E3 can see the transition.
  This is the one coordination point between the phases.
- **Phase 1 — Notion client.** Must query via
  `POST /v1/data_sources/{id}/query` on `Notion-Version: 2025-09-03`. The classic
  endpoint 400s on Daily Routine.
- **Resend secrets:** `RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO`.
- **Config:** `ALERT_TZ=Asia/Dhaka` (fixed +06:00, no DST).

## What this unblocks

- **Phase 5 dashboard** reads `alert_log` for a "recent notifications" panel.
- **Phase 6**, if revived, swaps `sendEmail` for a dual dispatch — the `Alert`
  shape and dedupe already carry everything a push needs.
- **Phase 7** adds TTL/pruning on `alerts_sent` and idempotent send ordering.

## Effort

**1 – 1.5 days.** The bulk is the local time-zone/window math for E8 and the
transition detection for E1–E3. The dispatcher, Resend call, and templates are
small.
