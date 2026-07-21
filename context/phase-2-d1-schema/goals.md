# Phase 2 — D1 Schema · Goals

## Objective

Define the **complete D1 (SQLite) schema** that backs the Notion Ops Dashboard. This
schema is the durable local mirror of Notion plus all operational bookkeeping the
Worker needs to run without ever blocking on the Notion API.

Concretely, Phase 2 delivers a single, reproducible `apps/worker/schema.sql` file that
creates every table the rest of the system depends on:

- **Snapshot tables** — a local mirror of the Notion databases we care about
  (`task_snapshot`, `timer_snapshot`, `routine_snapshot`, `txn_snapshot`,
  `goals_snapshot`). The dashboard reads exclusively from these, so page loads are a
  D1 query, not a Notion round-trip.
- **Sync cursor state** — `sync_state` persists the incremental-sync cursor and
  per-database watermarks so the `scheduled()` cron can resume mirroring where it left
  off.
- **Alert bookkeeping** — `alerts_sent` (dedupe) and `alert_log` (audit trail) so
  alert rules fire **once per condition window** and every send is recorded.
- **Device registry** — `device_tokens` stores FCM tokens so alerts can be pushed to
  registered devices.

This is a schema-only phase. No application logic, no sync code, no alert evaluation —
just the tables, indexes, comments, and a repeatable way to apply them.

## Scope

**In scope**

- All `CREATE TABLE IF NOT EXISTS` statements in `apps/worker/schema.sql`.
- Indexes that support the dashboard's read patterns and the alert engine's scans.
- Inline SQL comments and column-level rationale.
- A migrations strategy (numbered, idempotent `.sql` files).
- Applying the schema to both the **local** and **remote** D1 stores.

**Out of scope** (owned by later phases)

- The `scheduled()` cron and Notion → D1 upsert logic (Phase 3).
- Alert rule evaluation and FCM sending (Phase 4).
- Device registration endpoints (Phase 6).
- The dashboard UI and its queries (later phases).

## Exit Criteria

Phase 2 is done when **all** of the following hold:

1. **All tables exist locally.** Running the schema with `--local` creates every table
   and index without error.
2. **All tables exist remotely.** Running the schema with `--remote` creates the same
   objects in the remote D1 database `notion-ops`.
3. **Migrations are reproducible.** Re-running `schema.sql` against an already-migrated
   store is a no-op (guaranteed by `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
   EXISTS`) — no manual cleanup, no errors, no duplicate objects.
4. **Verification passes.** The table list query returns every expected table:

   ```powershell
   wrangler d1 execute notion-ops --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   ```

   Expected tables: `alert_log`, `alerts_sent`, `device_tokens`, `goals_snapshot`,
   `routine_snapshot`, `sync_state`, `task_snapshot`, `timer_snapshot`,
   `txn_snapshot`.

## Dependencies

| Dependency | Phase | Why it's required |
|---|---|---|
| D1 database `notion-ops` created and bound as `DB` | Phase 0 | `wrangler d1 execute notion-ops ...` targets a database that must already exist, and the Worker's `DB` binding must resolve. |
| `wrangler` installed and authenticated | Phase 0 | Needed to apply the schema to the remote store. |
| Monorepo layout with `apps/worker/` | Phase 0/1 | `schema.sql` lives at `apps/worker/schema.sql`. |

## What This Unblocks

| Unblocks | Phase | How it uses this schema |
|---|---|---|
| Notion → D1 mirroring | Phase 3 | Upserts into the `*_snapshot` tables; reads/writes the cursor in `sync_state`. |
| Alert engine | Phase 4 | Reads snapshots to evaluate rules; writes dedupe keys to `alerts_sent`; appends every send to `alert_log`. |
| Push notifications | Phase 6 | Registers and looks up FCM tokens in `device_tokens`. |
| Dashboard reads | Later | Query `*_snapshot` tables directly — never Notion. |

## Effort

**~½ day.** This is authoring a single SQL file, applying it to two stores, and
verifying. The care goes into getting column types, indexes, and dedupe semantics right
up front so later phases don't need destructive migrations.
