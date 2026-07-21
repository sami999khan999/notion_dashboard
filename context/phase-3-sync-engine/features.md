# Phase 3 — Sync Engine · Features

The sync engine is the beating heart of the Notion Ops Dashboard. It runs entirely
inside a single Cloudflare Worker and, once per minute, refreshes a local D1 mirror of
the five Notion databases. Everything downstream — alerts (Phase 4) and the dashboard
(Phase 5) — reads that mirror rather than talking to Notion directly.

This document describes the **capabilities** the engine provides. See
`implementation.md` for the code and `goals.md` for objectives and exit criteria.

---

## Capability overview

| Capability | Summary |
|------------|---------|
| Scheduled orchestration | A `scheduled()` cron (`* * * * *`) drives the whole pipeline each minute via `ctx.waitUntil(runSync(env))`. |
| Incremental cursor sync | Per-DB cursors in `sync_state` mean each run pulls only pages edited on-or-after the last successful sync. |
| Full pagination | `pullAllPages` follows Notion's `next_cursor` until `has_more === false`, so no changed page is missed. |
| Batch upserts | `env.DB.batch([...])` applies many `INSERT ... ON CONFLICT(notion_id) DO UPDATE` statements atomically per DB. |
| Previous-state capture | The prior `active_now` for each routine is read **before** upsert, enabling edge-triggered alerts in Phase 4. |
| Cursor persistence | After a successful pass the cursor is advanced (with a Phase-7 overlap hook) so the next run resumes exactly where this one left off. |
| Latency decoupling | The dashboard and alerts read a fast local mirror, insulated from Notion API latency and outages. |

---

## 1. Scheduled orchestration

The Worker's default export exposes two handlers:

- `scheduled(event, env, ctx)` — invoked by the Cloudflare cron trigger every minute.
  It wraps the async pipeline in `ctx.waitUntil(runSync(env))` so the runtime keeps the
  invocation alive until the full sync resolves, even after the handler returns.
- `fetch` — delegated to the TanStack Start request handler for the dashboard UI.

`runSync(env)` orchestrates the fixed five-step pipeline for every database:

1. **Pull** — read the cursor, incrementally pull changed pages (paginated).
2. **Normalize** — map raw Notion pages to typed rows via Phase 1 normalizers.
3. **Upsert** — batch write rows into snapshot tables (capturing previous state first).
4. **Run alerts** — call `runAlertRules(env)` (Phase 4; stubbed here).
5. **Advance cursor** — persist the new cursor so the next run is incremental.

Because the cadence is fixed and the work is bounded, the engine is predictable: every
minute it does a small, well-scoped amount of work and then goes quiet.

---

## 2. Incremental cursor sync

Each of the five databases has its own cursor stored in `sync_state` under a key such as
`cursor:tasks`, `cursor:timers`, `cursor:routine`, `cursor:txns`, `cursor:goals`.
A cursor is an ISO 8601 UTC timestamp representing "everything up to here is already
mirrored."

On each run the engine:

1. Reads the cursor for the DB (`getCursor`).
2. Queries Notion with a `last_edited_time` **on_or_after** filter set to that cursor.
3. Processes only the returned (changed) pages.
4. Advances the cursor (`setCursor`) to the run's start time once the DB is done.

This is what keeps Notion subrequests in the single digits per run. A steady-state tick
with no edits typically issues just one query per DB (five total) and often returns zero
pages. Contrast this with a naive full re-pull, which would page through every row of
every database every minute and quickly exhaust the Workers subrequest budget.

> **Phase 7 hook — cursor overlap.** To avoid boundary misses (a page edited in the same
> second the cursor was written, or clock skew between Notion and the Worker), Phase 7
> will rewind the effective `since` by ~2 minutes when querying. The cursor value stored
> is still the true run time; only the *query filter* is widened. Idempotent upserts make
> the small amount of re-processing harmless.

---

## 3. Full pagination

Notion's query API returns at most 100 results per request and signals more with
`has_more: true` plus a `next_cursor` token. `pullAllPages` is a generic loop — usable
for any of the five databases — that:

- Issues the first `queryDb` call with the incremental `last_edited_time` filter.
- While `has_more === true`, re-issues the query with `start_cursor: next_cursor`.
- Accumulates all pages, returning the complete changed set.

This guarantees completeness: even if a large batch of Notion edits lands between two
ticks, the engine drains all pages of the delta before advancing the cursor. Pagination
subrequests only occur when there is actually a large delta, so the common case stays
cheap.

---

## 4. Batch upserts

Normalized rows are written using D1's `env.DB.batch([...])`, which submits an array of
prepared statements in a single round trip. Each statement is an upsert:

```sql
INSERT INTO tasks (notion_id, ...) VALUES (?, ...)
ON CONFLICT(notion_id) DO UPDATE SET ... ;
```

Properties of this design:

- **Idempotent.** Re-processing the same page (e.g. due to overlap) produces the same
  row — the `ON CONFLICT` branch just re-writes identical values.
- **Efficient.** One batch per DB instead of N individual writes.
- **Atomic per batch.** D1 applies the batch as a unit, so a snapshot table never ends
  up half-updated within a single DB's write.

`notion_id` is the natural key across every table, which is why the conflict target is
always `notion_id`.

---

## 5. Previous-state capture for edge-triggered alerts

Some Phase 4 alerts fire on a **transition**, not a level. The canonical example is
**A4 (routine start)**: alert when a routine's `active_now` flips from `false` to
`true`.

Detecting a transition requires knowing the value *before* the update. Therefore, for
the routine database, the engine reads the current `active_now` values from the snapshot
table **before** upserting the new rows, and threads that "previous" map through to the
alert stage. Once the upsert runs, the old value is gone — so the ordering is a hard
requirement:

```
capture previous active_now  →  upsert routines  →  run alerts (compare prev vs new)
```

This document and `implementation.md` both call out that ordering explicitly because
getting it wrong silently breaks edge-triggered alerts (they would compare the new value
against itself and never fire).

---

## 6. Cursor persistence

After a DB's pages are pulled, normalized, and upserted, the engine writes the new
cursor via `setCursor`. Persistence in `sync_state` means the engine is stateless
between invocations — it can be redeployed, restarted, or scaled without losing its
place. On the very first run (no cursor yet), the engine uses a far-past date (epoch) so
the initial sync performs a full backfill, after which every subsequent run is
incremental.

> **Phase 7 hook — overlapping-run guard.** If a run risks exceeding ~60s (e.g. a huge
> backfill), a D1 lock row will prevent the next minute's tick from starting a
> concurrent run. Noted here; implemented in Phase 7.

---

## How this decouples the dashboard from Notion latency

Without a mirror, every dashboard page load and every alert evaluation would call the
Notion API directly. That would be:

- **Slow** — Notion API round trips add hundreds of milliseconds to seconds per query,
  and pagination multiplies that.
- **Fragile** — Notion rate limits and occasional outages would surface directly to
  users.
- **Expensive** — repeated identical reads waste the Workers subrequest budget.

The sync engine inverts this. It pays the Notion cost **once per minute, in the
background**, and writes the results into D1. Downstream:

- The **dashboard** (Phase 5) issues fast local D1 queries with predictable latency,
  regardless of Notion's state.
- **Alerts** (Phase 4) evaluate rules against the local mirror, so they run quickly and
  deterministically.

The trade-off is bounded staleness (up to ~1 minute), which is acceptable for an ops
dashboard and is the deliberate design choice that makes the whole system fast and
resilient.
