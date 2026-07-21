# Phase 7 — Hardening · Goals

## Objective

Take the fully-functional Notion Ops Dashboard pipeline — the Cloudflare Worker
that, on a cron `scheduled()` trigger, incrementally pulls Notion, upserts D1,
evaluates 7 alert rules, and pushes via FCM / email via Resend — and make it
**robust enough to run unattended for months** without a human babysitting it.

Phase 6 delivered *correct* behavior on the happy path. Phase 7 delivers
*durable* behavior on the unhappy path: recurring alerts that must re-fire the
next day, upstream rate limits, partial failures, retried invocations,
overlapping cron runs, growing tables, stale device tokens, and secret hygiene.

The output of this phase is not a new user-facing feature. It is a set of
guarantees about how the system behaves over time and under stress.

**Estimated effort: ½–1 day.** All items are surgical changes to existing code
plus a few new small helpers and scheduled maintenance queries. No new
subsystems.

---

## Scope recap

Eight hardening items, each with its own failure mode it eliminates:

1. **Dedupe TTL** — prune `alerts_sent` so recurring rules re-fire the next day.
2. **Stale push tokens** — purge long-inactive `device_tokens` rows.
3. **Incremental correctness** — overlap the sync cursor by ~120s.
4. **Rate limits** — honor Notion `429 Retry-After`; cap pages; stay under the
   Workers subrequest cap.
5. **Idempotent sends** — `alert_log` `pending → sent/failed` around every
   network call.
6. **Secrets** — everything token-like via `wrangler secret put`; nothing
   sensitive in `vars` or committed; `.dev.vars` gitignored.
7. **Observability** — `observability.enabled = true`; structured logs; readable
   via `wrangler tail`.
8. **Cron overlap guard** — a D1 lock row prevents two runs from double-processing.

---

## Exit criteria checklist

The phase is complete when **every** box below can be checked with evidence
(a log line, a query result, or a reproduced test), not just belief.

### Dedupe TTL
- [ ] Recurring rules (`overdue`, `budget`) that fired today do **not** re-fire
      again within the same day/window.
- [ ] The same recurring rules **do** re-fire the next day after the prune runs.
- [ ] "Once-ever" rules (e.g. status transitions) are never pruned and never
      re-fire for the same entity/threshold.
- [ ] The prune job is idempotent and safe to run repeatedly; running it twice in
      one day changes nothing after the first run.

### Stale push tokens
- [ ] Tokens are deactivated (`active=0`) on FCM `404`/`400` (from Phase 6 —
      verify still true).
- [ ] Rows with `active=0` older than the retention window are physically
      deleted by a scheduled purge.
- [ ] Active tokens are never deleted by the purge.

### Incremental correctness
- [ ] The stored cursor is `runStart − 120s`, not `runStart`.
- [ ] A page edited *during* a sync run is picked up on the following run (no
      boundary miss).
- [ ] Re-processing the small overlap window is harmless (upserts are
      idempotent — no duplicate rows, no duplicate alerts).

### Rate limits
- [ ] A Notion `429` response is retried after honoring `Retry-After`, with
      exponential backoff and a bounded number of attempts.
- [ ] Each run processes at most `MAX_PAGES_PER_RUN`; remaining work is deferred
      to the next run via the cursor, not dropped.
- [ ] Total subrequests per invocation stay comfortably under the Workers cap.

### Idempotent sends
- [ ] Every send writes an `alert_log` row with `status='pending'` **before** the
      network call.
- [ ] The row is updated to `'sent'` or `'failed'` **after** the call resolves.
- [ ] A retried invocation cannot double-send: the combination of `alerts_sent`
      dedupe + `alert_log` state makes a second delivery a no-op.

### Secrets
- [ ] Every token/key/credential is stored via `wrangler secret put`, not in
      `wrangler.toml` `[vars]`.
- [ ] `git log`/`git grep` shows no committed secrets, ever.
- [ ] `.dev.vars` is present in `.gitignore` and is not tracked.
- [ ] A written audit checklist exists and has been run once.

### Observability
- [ ] `observability.enabled = true` in `wrangler.toml`.
- [ ] Rule hits and send outcomes are logged as structured JSON.
- [ ] `wrangler tail` shows the structured events during a live run.
- [ ] Logs are filterable by rule name and status.

### Cron overlap guard
- [ ] A D1 lock row is acquired at the start of `scheduled()`.
- [ ] A second run that starts while a **fresh** lock exists exits immediately
      without processing.
- [ ] The lock **expires** (TTL) so a crashed run does not wedge the cron
      forever.
- [ ] The lock is released at the end of a normal run.

---

## Dependencies

Phase 7 is the last phase and assumes **all prior phases are complete and
merged**:

| Phase | Delivered | Why Phase 7 needs it |
|-------|-----------|----------------------|
| 1 | Worker + TanStack Start skeleton, `wrangler.toml`, D1 binding | The runtime being hardened |
| 2 | Notion client + incremental pull, `sync_state` | Cursor overlap + rate-limit wrapper attach here |
| 3 | D1 snapshot schema + idempotent upserts | Overlap re-processing relies on upsert idempotency |
| 4 | 7 alert rules + evaluation loop | Structured rule-hit logging attaches here |
| 5 | `alerts_sent` dedupe (PK rule/entity_id/threshold), `alert_log` audit | TTL prune + idempotent-send pattern build on these |
| 6 | Real FCM sender (`pushFcm`), Resend email, `device_tokens`, 404/400 deactivation | Token purge + idempotent send wrap these |

If any prior phase is incomplete, its guarantees are preconditions — do not start
Phase 7 against a moving base.

---

## Definition of Done — unattended operation

The system is "done" for Phase 7 when a reasonable operator would be comfortable
walking away from it for a month. Concretely:

1. **It self-maintains.** Tables do not grow without bound: `alerts_sent` is
   pruned daily, `device_tokens` dead rows are purged, `alert_log` retains audit
   history (optionally pruned at a longer horizon). No manual cleanup required.

2. **It re-alerts correctly.** Recurring conditions (an overdue task that stays
   overdue, a budget that stays over) re-notify the owner once per day, never
   multiple times per day, never never.

3. **It loses nothing.** No Notion edit falls through the cursor boundary. Work
   that exceeds a run's page budget is deferred, not dropped.

4. **It survives upstream turbulence.** Notion rate limiting, transient 5xx, and
   FCM token rejections are handled without crashing the run or spamming users.

5. **It never double-notifies.** Even if the platform retries a `scheduled()`
   invocation, or two crons overlap, each alert is delivered at most once.

6. **It is auditable.** Every notification attempt has an `alert_log` row and a
   structured log line; an operator can answer "did rule X fire for entity Y, and
   did the push succeed?" from logs and D1 alone.

7. **It is secure by construction.** No secret is recoverable from the repo or
   from `wrangler.toml`; rotating a key is a one-command operation.

8. **It cannot trip over itself.** Concurrent or retried invocations are
   serialized by the lock row, which cannot deadlock the pipeline because it
   expires.

When all eight hold and the exit-criteria checklist is fully green, Phase 7 —
and the project — is done.
