# Phase 7 — Hardening · Features

This document describes the **capabilities delivered** by the hardening phase.
None of these are user-facing screens; they are operational guarantees baked
into the pipeline. For each capability we state *what it does* and, more
importantly, *the specific failure it prevents*.

---

## 1. Dedupe lifecycle management (TTL on `alerts_sent`)

**Capability.** The `alerts_sent` table — whose primary key is
`(rule, entity_id, threshold)` — gains a lifecycle. A daily maintenance job
prunes rows so that recurring rules are free to fire again, while "once-ever"
rules keep their dedupe records forever. Each rule declares a TTL policy: some
reset daily (overdue tasks, budget overruns), some never reset (a one-time status
transition, an item entering a terminal state).

**Failure it prevents — two-sided.**
- *Without pruning (TTL too lax / infinite):* an overdue task fires an alert
  once, the dedupe row persists forever, and the task is **never re-flagged**
  even though it is still overdue tomorrow, next week, next month. The alert
  silently dies after the first day. This is the more dangerous failure because
  it is invisible — nothing errors, the alert just stops.
- *Without dedupe (TTL too aggressive):* the same overdue task fires on **every
  cron run** — potentially every few minutes — burying the owner in duplicate
  notifications until they mute the channel entirely.

The TTL strikes the balance: **re-fire once per day, not once per run, not
never.**

---

## 2. Push-token hygiene (`device_tokens` purge)

**Capability.** Building on Phase 6 (which already flips `active=0` when FCM
returns `404 UNREGISTERED` or `400 INVALID_ARGUMENT`), a scheduled purge
physically deletes `active=0` rows that have been inactive longer than a
retention window (e.g. 30 days). Active tokens are untouched.

**Failure it prevents.** Without hygiene, `device_tokens` accumulates dead rows
forever. Every alert fan-out iterates more tokens, most of which are guaranteed
to fail, wasting subrequests against the Workers cap and slowing every run. Over
months this turns a fast fan-out into a slow one dominated by known-dead tokens,
and it inflates D1 storage and read costs. The purge keeps the fan-out set equal
to the set of genuinely reachable devices. (Deactivation is kept separate from
deletion so that a brief retention window preserves debugging evidence — "why did
this device stop getting alerts?" — before the row disappears.)

---

## 3. Boundary-safe incremental sync (cursor overlap)

**Capability.** When the sync writes its cursor, it stores `runStart − 120s`
instead of `runStart`. The next run therefore re-queries a two-minute overlap
window against Notion's `last_edited_time` filter.

**Failure it prevents.** Notion's incremental filter is `last_edited_time >
cursor`. If a page is edited *while the current run is executing* — after the
run read `now` but before it finished paging — a naive cursor of exactly `now`
would exclude that page on the next run (its `last_edited_time` is ≤ the stored
cursor). The edit is **silently dropped forever**: the snapshot goes stale and
alerts based on it are wrong. The 120s overlap guarantees any edit near the run
boundary is re-seen next time. Re-processing the overlap is harmless because
upserts are idempotent (Phase 3) — same row in, same row out, no duplicate
alerts (dedupe in Phase 5).

---

## 4. Rate-limit resilience (Notion 429 + page cap + subrequest budget)

**Capability.** All Notion calls go through a `notionFetchWithRetry` wrapper that:
- detects `429`, reads the `Retry-After` header, waits that long, and retries;
- applies exponential backoff (with jitter) for transient `5xx` / network errors;
- caps total attempts so a persistently failing call surfaces an error instead
  of looping;
- and the sync loop caps pages processed per run (`MAX_PAGES_PER_RUN`), deferring
  the remainder to the next run via the cursor, keeping total subrequests under
  the Cloudflare Workers per-invocation cap.

**Failure it prevents.** Without it, a burst of Notion activity (or a large
backfill) causes `429`s that either crash the run — leaving the cursor
un-advanced and the snapshot stale — or, worse, causes the run to blow past the
Workers subrequest limit and be killed mid-sync, leaving D1 in a partially
updated state. The wrapper converts upstream throttling from a fatal event into
a graceful slowdown; the page cap converts a huge backlog from a crash into
several successive catch-up runs.

---

## 5. Idempotent delivery (`alert_log` pending → sent/failed)

**Capability.** Every notification write follows a two-phase pattern: insert an
`alert_log` row with `status='pending'` **before** the FCM/Resend network call,
then update it to `'sent'` or `'failed'` **after** the call resolves. Combined
with the `alerts_sent` dedupe insert, a delivery becomes a transactional,
resumable unit.

**Failure it prevents.** Cloudflare may **retry a `scheduled()` invocation** (or
a run may be interrupted after the push succeeds but before state is committed).
Without idempotency, the retry re-sends every alert the first attempt already
delivered — users get duplicate pushes for the same condition. With the pattern,
a retry sees the existing `alerts_sent` row (dedupe) and/or the `alert_log`
record and skips the send. The `pending` state also makes *stuck* sends
visible: a row that is `pending` long after its timestamp indicates a send that
started but never confirmed, distinguishable from one that cleanly failed.

---

## 6. Secret hygiene

**Capability.** Every token-like value — Notion integration token, FCM/service
account credentials, Resend API key, any signing secret — is stored via
`wrangler secret put` and read from the encrypted secret store at runtime.
`wrangler.toml` `[vars]` holds only non-sensitive config. `.dev.vars` (local
secrets) is gitignored. A written audit checklist verifies the repo history is
clean.

**Failure it prevents.** A secret committed to git — even once, even later
"removed" — lives in history forever and is one repo-access away from full
compromise of the Notion workspace and the ability to send arbitrary
notifications to every device. Storing secrets in `[vars]` puts them in plaintext
in the committed config. This capability makes leakage structurally impossible
in the normal workflow and makes rotation a single command.

---

## 7. Observability

**Capability.** `observability.enabled = true` turns on Workers logs. The
pipeline emits **structured JSON** log events for the key lifecycle points: sync
start/finish with counts, each rule hit (rule, entity, threshold), and each send
outcome (channel, target, status, latency). `wrangler tail` streams these live;
the structure makes them filterable by rule and status.

**Failure it prevents.** Without observability, an unattended system fails
*silently*. When a user asks "why didn't I get alerted about X?", an operator
with only unstructured `console.log` (or nothing) cannot answer. Structured logs
turn every run into an auditable record: you can confirm whether a rule fired,
whether the send succeeded, and how long Notion took — the difference between
"the system is a black box" and "the system explains itself."

---

## 8. Concurrency guard (D1 lock row)

**Capability.** `scheduled()` acquires a lock row in D1 at the start of a run,
stamped with the current time. If a **fresh** lock already exists, the new run
exits immediately. The lock has a TTL: a lock older than the TTL is considered
stale and may be overtaken. A normal run releases the lock at the end.

**Failure it prevents.** If one run runs long (near the 60s wall) and the next
cron tick fires before it finishes, two runs execute concurrently. They can
double-process the same Notion pages, race on the same `alerts_sent`/`alert_log`
rows, and potentially double-send. The lock serializes runs. Critically, the
**TTL on the lock** prevents the opposite failure: if a run crashes without
releasing the lock, a permanent lock would wedge the cron forever — no run could
ever acquire it. Expiry guarantees the pipeline self-heals after a crash within
one TTL window.

---

## Summary table

| # | Capability | Failure prevented | Mechanism |
|---|-----------|-------------------|-----------|
| 1 | Dedupe lifecycle (TTL) | Recurring alerts die forever *or* spam every run | Daily prune of `alerts_sent`, per-rule TTL |
| 2 | Token hygiene | Fan-out clogged with dead tokens | Scheduled purge of stale `active=0` rows |
| 3 | Boundary-safe sync | Edits at the run boundary silently lost | Cursor = `runStart − 120s` |
| 4 | Rate-limit resilience | 429/backlog crashes run or exceeds subrequest cap | `notionFetchWithRetry` + page cap |
| 5 | Idempotent delivery | Retried invocation double-sends | `alert_log` pending→sent/failed + dedupe |
| 6 | Secret hygiene | Leaked credentials in git/vars | `wrangler secret put`, gitignore, audit |
| 7 | Observability | Silent failures, unanswerable "why no alert?" | Structured logs + `wrangler tail` |
| 8 | Concurrency guard | Overlapping runs double-process | D1 lock row with TTL |
