# Phase 3 — Sync Engine · Goals

## Objective

Build the **sync engine** that keeps the D1 database an accurate, low-latency mirror
of the five Notion source databases. A single Cloudflare Worker runs a `scheduled()`
cron every minute (`* * * * *`). On each tick it orchestrates the full pipeline:

```
pull → normalize → upsert → run alerts → advance cursor
```

The engine performs **incremental** synchronization: instead of re-reading every
Notion page on every run, it reads a per-database cursor from `sync_state`, pulls only
pages whose `last_edited_time` is on-or-after that cursor, normalizes them with the
Phase 1 client, batch-upserts them into the Phase 2 snapshot tables via
`INSERT ... ON CONFLICT(notion_id) DO UPDATE`, and then advances the cursor to the
current time. Because only changed pages are pulled, each run issues a **single-digit**
number of Notion subrequests — comfortably under the Workers subrequest cap.

The result is a self-healing mirror: any edit made in Notion is reflected in D1 within
roughly one minute, with no user action required.

## Scope of this phase

In scope:

- The Worker default export wiring `scheduled()` (cron) and `fetch` (TanStack Start).
- `runSync(env)` — the orchestration function.
- `getCursor` / `setCursor` — per-DB cursor persistence in `sync_state`.
- `pullAllPages` — generic full pagination over any of the five databases.
- `upsertTasks` / `upsertTimers` / `upsertRoutine` / `upsertTxns` / `upsertGoals` —
  batch upserts using `env.DB.batch()`.
- **Previous-state capture** for routines so Phase 4 can detect `active_now`
  false→true edge transitions (capture happens *before* the upsert overwrites it).
- A stub call to `runAlertRules(env)` (implemented fully in Phase 4).

Out of scope (referenced but deferred):

- Alert rule logic itself → **Phase 4**.
- Dashboard/read UI → **Phase 5**.
- Cursor overlap window, overlapping-run lock (D1 lock row), retry/backoff hardening
  → **Phase 7** (hooks are noted where relevant).

## Exit criteria

The phase is complete when all of the following hold under `wrangler dev`:

| # | Criterion | How it is demonstrated |
|---|-----------|------------------------|
| E1 | A Notion edit mirrors into D1 | Edit a page in one of the five Notion DBs, trigger a cron tick, and the matching snapshot row in D1 reflects the new field values. |
| E2 | Cursor advances | After a successful run, `sync_state` holds an updated `cursor:<db>` value at/after the run start time for each DB. |
| E3 | Re-run is incremental | With no further Notion edits, a second cron tick pulls **only** changed pages (single-digit subrequests), and the previously-seen row is untouched or re-upserted idempotently. |

Concretely: *editing a Notion page then triggering a cron tick updates the matching D1
snapshot row; the cursor advances; a re-run pulls only changed pages.*

## Dependencies

| Depends on | What it provides |
|------------|------------------|
| **Phase 1 — Notion client** | `queryDb`, per-DB pull helpers, and normalizers (`normalizeTask`, `normalizeTimer`, `normalizeRoutine`, `normalizeTxn`, `normalizeGoal`). |
| **Phase 2 — D1 schema** | Snapshot tables (one per DB) keyed by `notion_id`, plus the `sync_state` key/value table holding per-DB cursors. |

Env bindings required: the D1 binding `DB`, and the Notion database id env vars
`DB_ROUTINE`, `DB_TASKS`, `DB_TIMER`, `DB_TXN`, `DB_GOALS`.

## What this unblocks

- **Phase 4 — Alerts** reads the D1 mirror (never Notion directly) to evaluate alert
  rules. It specifically relies on the previous-state capture wired here to detect
  edge transitions such as **A4 (routine start)** — a `active_now` false→true flip.
- **Phase 5 — Dashboard** reads the D1 mirror to render all views. Because the mirror
  is decoupled from Notion, the dashboard is fast and resilient to Notion API latency
  or outages.

## Effort

**~1 day.** The pipeline shape is small and the reference code already sketches the
control flow; most of the work is fanning the pattern out across all five databases,
writing the `ON CONFLICT` upserts, and wiring the previous-state capture.
