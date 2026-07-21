# Phase 4 — Alert Engine + Channels — Goals

## Objective

Turn the fresh D1 snapshot that Phase 3 writes on every cron tick into **actionable, de-duplicated notifications**. Phase 4 adds an alert engine to the single Cloudflare Worker: after the `scheduled()` handler pulls Notion and upserts the D1 snapshot tables, it runs a fixed set of **seven alert rules** against that snapshot, then dispatches every un-sent alert through the appropriate channel.

The design goal is that **each rule is a pure function** `(snapshot) → Alert[]`. Rules never touch the network and never mutate state — they only read the snapshot and return candidate alerts. All the messy parts (deduplication, channel dispatch, audit logging) live in one small dispatcher (`runAlertRules`) that is easy to reason about and test.

Two channels ship in this phase:

- **Push** — the primary channel, targeting a Flutter app via FCM. FCM itself is built in **Phase 6**. In Phase 4, `pushFcm` is a **stub** that writes to `alert_log` so every push-channel rule is fully verifiable *without a phone*.
- **Email** — the secondary channel, via the **Resend HTTP API**. Cloudflare Workers cannot open SMTP connections, so email must go over HTTPS. Resend is used for A5 (routine-missed digest) and A6 (budget threshold, which fires on both push and email).

All timestamps are stored and compared in **ISO 8601 UTC**. Human-facing day boundaries ("today", "next 24h", "21:00", "end-of-day") are resolved against a **configurable local time zone** (see `implementation.md`).

## Scope

In scope:

- The `Alert` type and the seven pure rule functions (A1–A7).
- The `runAlertRules` dispatcher with dedupe against `alerts_sent`.
- `recordSent` writing both `alerts_sent` (dedupe key) and `alert_log` (audit trail).
- `sendEmail` via Resend HTTP API.
- The `pushFcm` **stub** that logs to `alert_log`.
- Coordination with Phase 3 for the A4 edge-trigger (previous `active_now` captured before upsert).
- Local test harness: seed snapshot rows in local D1, run the engine, assert `alert_log` rows.

Out of scope (deferred):

- Real FCM push delivery → **Phase 6**.
- Dedupe TTL / re-arming windows and full idempotency treatment around network calls → **Phase 7**.
- User-configurable rule thresholds via UI → later phase (thresholds are read from `goals`/env in this phase).

## Exit criteria

Phase 4 is done when all of the following hold:

1. **All 7 rules implemented as pure functions.** Each of A1–A7 is a function `(snapshot/env) → Alert[]` with no side effects, returning zero or more `Alert` candidates.
2. **Dedupe prevents double-send across cron ticks.** A rule that is continuously true across many consecutive ticks (e.g. an orphan timer that stays running for 60 minutes) fires **once**, not once per tick. Dedupe is keyed on the composite `(rule, entity_id, threshold)`.
3. **A4 edge-trigger fires once at start.** The "routine block starting" alert fires on the `active_now` transition `false → true` and does **not** re-fire while the block stays active. This requires reading the *previous* `active_now` from the snapshot before Phase 3 upserts the new value.
4. **A6 fires at 80% and 100% independently.** The budget-threshold rule emits a candidate for the `"80"` tier and a separate candidate for the `"100"` tier. Because `threshold` is part of the dedupe key, each tier fires exactly once per month per goal, and both can fire.
5. **Every candidate is recorded in `alert_log`.** Whether the channel is push (stub) or email, a successful dispatch results in exactly one `alert_log` row and one `alerts_sent` row. Re-running the cron does not produce duplicate rows.

Concretely, the acceptance test is: seed the local D1 snapshot so each rule's condition is true, invoke the scheduled handler, and confirm exactly one `alert_log` entry per triggered rule/entity/threshold. Re-invoke without changing the snapshot and confirm **no new** `alert_log` rows.

> Push landing on an actual phone is validated in **Phase 6**. In Phase 4 the "delivery" is a row in `alert_log`.

## Dependencies

- **Phase 2 — Notion sync + D1 schema.** Provides the snapshot tables (`timer_snapshot`, `task_snapshot`, `routine_snapshot`, `txn_snapshot`) and the `goals` table the rules read from, plus the `alerts_sent` and `alert_log` tables the dispatcher writes to.
- **Phase 3 — Cron + upsert pipeline.** Provides the `scheduled()` handler and the upsert step. Phase 4 hooks `runAlertRules(env)` in **after** the upsert completes. Critically, Phase 3 must expose the **previous `active_now`** value for each routine (captured before upsert) so A4 can detect the edge — this is a coordination point, documented in `implementation.md`.
- **Resend secrets.** `RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO` must be set as Worker secrets/vars. Without them, email rules (A5, A6) cannot dispatch.
- **Config var** for the local time zone used to compute day boundaries (e.g. `ALERT_TZ`).

## What this unblocks

- **Phase 6 — Real push.** The stubbed `pushFcm` is swapped for a real FCM sender. Because every push rule already produces a well-formed `Alert` and the dispatch path is isolated, Phase 6 only changes one function.
- **Phase 7 — Dedupe TTL / re-arming.** The `alerts_sent` table and its composite key are the foundation for time-boxed re-arming (e.g. "an overdue task can alert again the next day"). Phase 7 adds TTL semantics and the full idempotent-send treatment (ordering the log write relative to the network call).

## Effort

**1 – 1.5 days.** Most of the time is careful SQL for the seven rules (date math, month grouping, sum-of-seconds) and the local test harness. The dispatcher, channels, and logging are small.
