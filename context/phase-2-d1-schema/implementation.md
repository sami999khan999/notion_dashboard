# Phase 2 — D1 Schema · Implementation

This document is the authoritative reference for `apps/worker/schema.sql`: the full DDL,
the rationale for every column, how to apply it to local and remote D1, the migrations
strategy, data-type conventions, verification, and pitfalls.

- **File:** `apps/worker/schema.sql`
- **Database:** `notion-ops` (D1), bound in the Worker as `DB`
- **Store model:** SQLite. Local and remote are **separate** databases (see Pitfalls).

## The complete `schema.sql`

Every statement uses `IF NOT EXISTS` so the file is idempotent — safe to re-run against a
store that's already been migrated.

```sql
-- apps/worker/schema.sql
-- D1 (SQLite) schema for the Notion Ops Dashboard.
-- Idempotent: every object uses IF NOT EXISTS so this file can be re-applied safely.
-- Conventions:
--   * Booleans are stored as INTEGER 0/1 (SQLite has no BOOLEAN type).
--   * All timestamps/dates are ISO 8601 UTC strings (TEXT), e.g. "2026-07-21T14:03:00Z".
--   * Money and Notion formula/number values are REAL; counters/durations are INTEGER.
--   * *_snapshot tables mirror Notion; notion_id is the Notion page id and the PK.

-------------------------------------------------------------------------------
-- Sync cursor / key-value state
-------------------------------------------------------------------------------
-- Persists the incremental-sync cursor and per-database watermarks between cron
-- runs. value is opaque TEXT (a timestamp, or a JSON blob) keyed by a well-known key.
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,   -- well-known key, e.g. "cursor:tasks", "last_full_sync"
  value      TEXT NOT NULL,      -- opaque serialized value (timestamp or JSON)
  updated_at TEXT NOT NULL       -- ISO 8601 UTC when this key was last written
);

-------------------------------------------------------------------------------
-- Notion snapshot mirrors
-------------------------------------------------------------------------------

-- Mirror of the Notion Tasks database. One row per task page.
CREATE TABLE IF NOT EXISTS task_snapshot (
  notion_id     TEXT PRIMARY KEY,  -- Notion page id
  title         TEXT,              -- task title (Notion title property)
  status        TEXT,              -- status/select value, e.g. "In Progress"
  deadline      TEXT,              -- ISO 8601 date/datetime, nullable
  completed     INTEGER,           -- boolean 0/1
  archived      INTEGER,           -- boolean 0/1 (Notion archived flag)
  progress      REAL,              -- 0.0..1.0 (Notion formula/rollup)
  seconds_today INTEGER,           -- time tracked today, aggregated from timers
  updated       TEXT               -- Notion last_edited_time (ISO 8601), drives sync
);

-- Mirror of the Notion Timers database. Running + historical time entries.
CREATE TABLE IF NOT EXISTS timer_snapshot (
  notion_id     TEXT PRIMARY KEY,  -- Notion page id
  name          TEXT,              -- timer label
  task_id       TEXT,              -- related task_snapshot.notion_id (relation), nullable
  status        TEXT,              -- e.g. "running" / "stopped"
  start_time    TEXT,              -- ISO 8601 UTC
  end_time      TEXT,              -- ISO 8601 UTC, null while running
  total_seconds INTEGER,           -- computed duration in seconds
  updated       TEXT               -- Notion last_edited_time (ISO 8601)
);

-- Mirror of the Notion Routines database. Scheduled recurring activities.
CREATE TABLE IF NOT EXISTS routine_snapshot (
  notion_id  TEXT PRIMARY KEY,     -- Notion page id
  activity   TEXT,                 -- routine label
  time       TEXT,                 -- scheduled time-of-day, e.g. "08:00"
  date       TEXT,                 -- occurrence date, ISO 8601 (YYYY-MM-DD)
  active_now INTEGER,              -- boolean 0/1: is the routine window active now
  done       INTEGER,              -- boolean 0/1: completed for this occurrence
  updated    TEXT                  -- Notion last_edited_time (ISO 8601)
);

-- Mirror of the Notion Transactions (finance) database.
CREATE TABLE IF NOT EXISTS txn_snapshot (
  notion_id TEXT PRIMARY KEY,      -- Notion page id
  name      TEXT,                  -- transaction description
  amount    REAL,                  -- raw magnitude (always >= 0)
  type      TEXT,                  -- "income" / "expense"
  category  TEXT,                  -- category select
  account   TEXT,                  -- account select
  month     TEXT,                  -- YYYY-MM bucket for monthly rollups
  signed    REAL,                  -- signed amount: +income / -expense (precomputed)
  date      TEXT                   -- transaction date, ISO 8601 (YYYY-MM-DD)
);

-- Mirror of the Notion Goals database. Per-month budget targets.
CREATE TABLE IF NOT EXISTS goals_snapshot (
  notion_id    TEXT PRIMARY KEY,   -- Notion page id
  name         TEXT,               -- goal name/label
  month        TEXT,               -- YYYY-MM this goal applies to
  income_goal  REAL,               -- target income for the month
  expense_goal REAL,               -- budgeted (max) expense for the month
  updated      TEXT                -- Notion last_edited_time (ISO 8601)
);

-------------------------------------------------------------------------------
-- Device registry (FCM push targets)
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_tokens (
  token         TEXT PRIMARY KEY,  -- FCM registration token
  platform      TEXT,              -- "android" / "ios" / "web"
  active        INTEGER DEFAULT 1, -- boolean 0/1; soft-disable stale tokens
  registered_at TEXT,              -- ISO 8601 UTC of first registration
  last_seen     TEXT               -- ISO 8601 UTC of most recent heartbeat/register
);

-------------------------------------------------------------------------------
-- Alert bookkeeping
-------------------------------------------------------------------------------
-- Dedupe: composite PK enforces one alert per (rule, entity, condition window).
-- Phase 4 uses INSERT OR IGNORE; a successful insert == "new condition, send it".
CREATE TABLE IF NOT EXISTS alerts_sent (
  rule      TEXT,                  -- rule id, e.g. "task_overdue", "budget_over"
  entity_id TEXT,                  -- entity key, e.g. task notion_id or "2026-07"
  threshold TEXT,                  -- condition window/bucket that was crossed
  sent_at   TEXT,                  -- ISO 8601 UTC when the dedupe row was written
  PRIMARY KEY (rule, entity_id, threshold)
);

-- Audit trail: append-only record of every delivery attempt.
CREATE TABLE IF NOT EXISTS alert_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  rule      TEXT,                  -- rule id that produced the alert
  entity_id TEXT,                  -- entity the alert was about
  channel   TEXT,                  -- delivery channel, e.g. "fcm"
  message   TEXT,                  -- rendered message body
  status    TEXT,                  -- "sent" / "failed" / ...
  sent_at   TEXT                   -- ISO 8601 UTC of the attempt
);

-------------------------------------------------------------------------------
-- Indexes (support dashboard reads + alert-engine scans)
-------------------------------------------------------------------------------
-- Overdue / due-soon scans: filter by deadline among not-completed, not-archived.
CREATE INDEX IF NOT EXISTS idx_task_due
  ON task_snapshot (deadline, completed, archived);

-- "Currently running timer" and status rollups.
CREATE INDEX IF NOT EXISTS idx_timer_status
  ON timer_snapshot (status);

-- Timers by task (aggregation into seconds_today, per-task views).
CREATE INDEX IF NOT EXISTS idx_timer_task
  ON timer_snapshot (task_id);

-- "What's active now" for a given date.
CREATE INDEX IF NOT EXISTS idx_routine_active
  ON routine_snapshot (active_now, date);

-- Monthly finance rollups grouped by type.
CREATE INDEX IF NOT EXISTS idx_txn_month_type
  ON txn_snapshot (month, type);

-- Budget goals lookup by month.
CREATE INDEX IF NOT EXISTS idx_goals_month
  ON goals_snapshot (month);

-- Active push targets fan-out.
CREATE INDEX IF NOT EXISTS idx_device_active
  ON device_tokens (active);

-- Recent-alerts view / audit queries ordered by time.
CREATE INDEX IF NOT EXISTS idx_alert_log_sent
  ON alert_log (sent_at);
```

## Column-by-column rationale

### `sync_state`

| Column | Type | Meaning | Source |
|---|---|---|---|
| `key` | TEXT (PK) | Well-known state key, e.g. `cursor:tasks`, `last_full_sync` | Chosen by the sync code |
| `value` | TEXT (NOT NULL) | Opaque serialized value — a timestamp or JSON blob | Sync code |
| `updated_at` | TEXT (NOT NULL) | ISO 8601 UTC of last write | Sync code (`new Date().toISOString()`) |

### `task_snapshot`

| Column | Type | Meaning | Source (Notion) |
|---|---|---|---|
| `notion_id` | TEXT (PK) | Notion page id, stable identity for upserts | page `id` |
| `title` | TEXT | Task title | title property |
| `status` | TEXT | Status / select value | status/select property |
| `deadline` | TEXT | Due date/datetime, ISO 8601, nullable | date property |
| `completed` | INTEGER | Boolean 0/1 | checkbox / status derived |
| `archived` | INTEGER | Boolean 0/1 | page `archived` flag |
| `progress` | REAL | 0.0–1.0 completion | formula / rollup |
| `seconds_today` | INTEGER | Time tracked today | aggregated from `timer_snapshot` by sync |
| `updated` | TEXT | Last edit time, drives incremental sync | `last_edited_time` |

### `timer_snapshot`

| Column | Type | Meaning | Source (Notion) |
|---|---|---|---|
| `notion_id` | TEXT (PK) | Notion page id | page `id` |
| `name` | TEXT | Timer label | title property |
| `task_id` | TEXT | Related task's `notion_id`, nullable | relation property |
| `status` | TEXT | `running` / `stopped` | status/select property |
| `start_time` | TEXT | Interval start, ISO 8601 UTC | date property |
| `end_time` | TEXT | Interval end, null while running | date property |
| `total_seconds` | INTEGER | Duration in seconds | formula, or computed by sync |
| `updated` | TEXT | Last edit time | `last_edited_time` |

### `routine_snapshot`

| Column | Type | Meaning | Source (Notion) |
|---|---|---|---|
| `notion_id` | TEXT (PK) | Notion page id | page `id` |
| `activity` | TEXT | Routine label | title property |
| `time` | TEXT | Scheduled time-of-day | text/select property |
| `date` | TEXT | Occurrence date, ISO 8601 | date property |
| `active_now` | INTEGER | Boolean 0/1: window active now | formula, or computed by sync |
| `done` | INTEGER | Boolean 0/1: completed | checkbox property |
| `updated` | TEXT | Last edit time | `last_edited_time` |

### `txn_snapshot`

| Column | Type | Meaning | Source (Notion) |
|---|---|---|---|
| `notion_id` | TEXT (PK) | Notion page id | page `id` |
| `name` | TEXT | Description | title property |
| `amount` | REAL | Raw magnitude (>= 0) | number property |
| `type` | TEXT | `income` / `expense` | select property |
| `category` | TEXT | Category | select property |
| `account` | TEXT | Account | select property |
| `month` | TEXT | `YYYY-MM` bucket | derived from `date` by sync |
| `signed` | REAL | +income / -expense, precomputed | derived from `amount` + `type` |
| `date` | TEXT | Transaction date, ISO 8601 | date property |

### `goals_snapshot`

| Column | Type | Meaning | Source (Notion) |
|---|---|---|---|
| `notion_id` | TEXT (PK) | Notion page id | page `id` |
| `name` | TEXT | Goal name/label | title property |
| `month` | TEXT | `YYYY-MM` this goal applies to | select/text or derived |
| `income_goal` | REAL | Target income for the month | number property |
| `expense_goal` | REAL | Budgeted max expense | number property |
| `updated` | TEXT | Last edit time | `last_edited_time` |

### `device_tokens`

| Column | Type | Meaning | Source |
|---|---|---|---|
| `token` | TEXT (PK) | FCM registration token | device registration (Phase 6) |
| `platform` | TEXT | `android` / `ios` / `web` | registration payload |
| `active` | INTEGER (DEFAULT 1) | Boolean 0/1; soft-disable stale tokens | Worker |
| `registered_at` | TEXT | First registration, ISO 8601 UTC | Worker |
| `last_seen` | TEXT | Most recent register/heartbeat | Worker |

### `alerts_sent`

| Column | Type | Meaning | Source |
|---|---|---|---|
| `rule` | TEXT (PK part) | Rule id, e.g. `task_overdue` | alert engine |
| `entity_id` | TEXT (PK part) | Entity key (task id, or `YYYY-MM`) | alert engine |
| `threshold` | TEXT (PK part) | Condition window/bucket crossed | alert engine |
| `sent_at` | TEXT | ISO 8601 UTC dedupe row written | alert engine |

### `alert_log`

| Column | Type | Meaning | Source |
|---|---|---|---|
| `id` | INTEGER (PK, AUTOINCREMENT) | Surrogate key | SQLite |
| `rule` | TEXT | Rule id | alert engine |
| `entity_id` | TEXT | Entity alerted about | alert engine |
| `channel` | TEXT | `fcm`, etc. | alert engine |
| `message` | TEXT | Rendered body | alert engine |
| `status` | TEXT | `sent` / `failed` | alert engine |
| `sent_at` | TEXT | ISO 8601 UTC of attempt | alert engine |

## Applying the schema

Run from the `apps/worker/` directory (where `schema.sql` and `wrangler.toml` live).
PowerShell-friendly — these are single-line invocations, no shell-specific quoting needed.

**Local store** (the Miniflare/`wrangler dev` SQLite file on disk):

```bash
wrangler d1 execute notion-ops --local --file=./schema.sql
```

**Remote store** (the real D1 database in your Cloudflare account):

```bash
wrangler d1 execute notion-ops --remote --file=./schema.sql
```

The remote command may prompt for confirmation; add `--yes` to skip the prompt in CI:

```bash
wrangler d1 execute notion-ops --remote --file=./schema.sql --yes
```

> Both must succeed to meet the exit criteria. Local and remote are independent stores;
> applying to one does **not** affect the other.

## Migrations strategy

For Phase 2, applying `schema.sql` twice (local + remote) is sufficient because every
statement is idempotent. As the schema evolves, adopt a **numbered migration** convention
so changes are ordered, reproducible, and safe to re-run.

**Layout**

```
apps/worker/
  schema.sql                 # canonical, always-current full schema (idempotent)
  migrations/
    0001_init.sql            # initial tables + indexes (this phase)
    0002_add_task_priority.sql
    0003_...
```

**Principles**

1. **Idempotent statements.** Prefer `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
   EXISTS`. Re-running a migration must be a no-op, never an error.
2. **Additive and ordered.** Number files monotonically (`0001`, `0002`, …). Never edit a
   migration that's already been applied to remote — write a new one.
3. **Apply the same file to both stores.** Every migration is run with `--local` and
   `--remote`.
4. **Keep `schema.sql` in sync.** `schema.sql` is the flattened current-state view (handy
   for fresh setups and reading); migrations are the incremental history.

**Adding a column later** — SQLite `ALTER TABLE ... ADD COLUMN` is supported and cheap
(it doesn't rewrite the table). Because SQLite doesn't support `ADD COLUMN IF NOT EXISTS`,
guard idempotency by making the migration the source of truth for that step:

```sql
-- migrations/0002_add_task_priority.sql
-- Add a priority field to tasks. Re-running errors only if already applied;
-- run each numbered migration exactly once per store.
ALTER TABLE task_snapshot ADD COLUMN priority TEXT;
CREATE INDEX IF NOT EXISTS idx_task_priority ON task_snapshot (priority);
```

If you need re-runnable safety for `ADD COLUMN`, check `PRAGMA table_info(task_snapshot)`
in the applying script and skip the `ALTER` when the column already exists, or use
`wrangler`'s migrations tooling (`wrangler d1 migrations apply notion-ops`) which tracks
applied migrations in a `d1_migrations` table so each runs at most once.

## Data-type conventions

SQLite (and therefore D1) has a small set of storage classes: `NULL`, `INTEGER`, `REAL`,
`TEXT`, `BLOB`. There is **no** native boolean, date, or decimal type. We map Notion's
richer types onto these deliberately:

| Concept | Stored as | Convention |
|---|---|---|
| Boolean | `INTEGER` | `0` = false, `1` = true. Query with `WHERE completed = 1`. Never rely on truthiness of TEXT. |
| Timestamp / datetime | `TEXT` | ISO 8601 **UTC** string, e.g. `2026-07-21T14:03:00Z`. Lexicographic order == chronological order, so `ORDER BY` and range filters work directly. |
| Date-only | `TEXT` | ISO 8601 `YYYY-MM-DD`. Month bucket is `YYYY-MM`. |
| Money / number | `REAL` | Notion number properties. `amount` is unsigned; `signed` carries direction. |
| Notion **formula (number)** | `REAL` | e.g. `progress`, `total_seconds` if formula-derived. |
| Notion **formula (checkbox)** | `INTEGER` | 0/1, same as any boolean. |
| Counter / duration | `INTEGER` | Whole seconds (`seconds_today`, `total_seconds`), whole counts. |
| Notion page id | `TEXT` | Used as `notion_id` PK for stable upserts. |

**Formula value mapping in detail.** Notion formulas resolve to a typed value; map by the
resolved type, not by the fact that it's a formula:

- Formula → number that's conceptually whole (seconds, counts) → `INTEGER`.
- Formula → number that's fractional (ratios like `progress`, money) → `REAL`.
- Formula → checkbox/boolean → `INTEGER` 0/1.
- Formula → string/date → `TEXT` (ISO 8601 for dates).

Do the coercion in the sync layer (Phase 3) so the snapshot columns always hold clean,
typed values — the dashboard and alert engine never parse ambiguous strings.

## Verification

After applying, confirm every table exists:

```bash
wrangler d1 execute notion-ops --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected rows: `alert_log`, `alerts_sent`, `device_tokens`, `goals_snapshot`,
`routine_snapshot`, `sync_state`, `task_snapshot`, `timer_snapshot`, `txn_snapshot`.
(SQLite may also list internal tables like `sqlite_sequence` — created because
`alert_log` uses `AUTOINCREMENT` — and, if you use `wrangler` migrations, `d1_migrations`.
Those are expected.)

Confirm indexes exist:

```bash
wrangler d1 execute notion-ops --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
```

Repeat both against remote by swapping `--local` for `--remote`. Both stores must return
the full set to satisfy the exit criteria.

## Pitfalls

- **D1 is SQLite — no native boolean/date/decimal types.** Enforce the 0/1 and ISO-8601
  conventions in code; the database won't do it for you. A stray `"true"`/`"false"` string
  in an INTEGER-intended column will silently break `= 1` filters.
- **Local and remote are separate stores.** `--local` writes a file on your machine
  (Miniflare); `--remote` writes the actual D1 database. Migrating one never touches the
  other. Always apply to both, and remember `wrangler dev` uses the **local** store by
  default.
- **Composite PK dedupe semantics.** `alerts_sent`'s PK is `(rule, entity_id, threshold)`.
  Dedupe correctness depends entirely on choosing a `threshold` that represents the
  *condition window* you want to alert once per. Too coarse a `threshold` → missed
  re-alerts when a new window is crossed; too fine → duplicate spam. Phase 4 must use
  `INSERT OR IGNORE` (or `ON CONFLICT DO NOTHING`) and treat "row inserted" as the signal
  to send.
- **`AUTOINCREMENT` creates `sqlite_sequence`.** Expected; don't be alarmed when it shows
  up in the table list.
- **ISO-8601 ordering only works in UTC with a fixed format.** Mixing offsets (`+05:30`)
  or omitting zero-padding breaks lexicographic ordering. Always store `...Z` UTC.
- **`month` must be derived consistently.** `txn_snapshot.month` and
  `goals_snapshot.month` must use the identical `YYYY-MM` format or the budget-rule join
  in Phase 4 silently returns nothing.
- **Re-running raw `ALTER TABLE` migrations errors.** Only `CREATE ... IF NOT EXISTS` is
  self-idempotent. Track applied migrations (numbered files run once per store, or
  `wrangler d1 migrations apply`) so `ADD COLUMN` steps don't fail on a second run.
