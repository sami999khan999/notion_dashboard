-------------------------------------------------------------------------------
-- Notion Ops Dashboard — D1 schema
--
-- Idempotent and re-appliable: every statement uses IF NOT EXISTS. Apply to
-- BOTH stores, they are separate:
--   npx wrangler d1 execute notion-ops --local  --file=schema.sql
--   npx wrangler d1 execute notion-ops --remote --file=schema.sql
--
-- All timestamps are ISO 8601 UTC strings. Local wall-clock (Asia/Dhaka) is a
-- presentation/alert-window concern only and never stored.
-------------------------------------------------------------------------------

-- Incremental sync cursors, keyed by dataset ("tasks", "timer").
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-------------------------------------------------------------------------------
-- Snapshots — a local mirror of Notion so the dashboard never waits on the API
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_snapshot (
  notion_id      TEXT PRIMARY KEY,
  title          TEXT,
  status         TEXT,     -- always "Stoped" in practice; kept for fidelity
  category       TEXT,
  deadline       TEXT,     -- RAW Notion value: "2026-02-22" or full ISO datetime.
                           -- Precision is meaningful — do not normalise it.
  date           TEXT,
  completed      INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  progress       TEXT,     -- "Task Progress" formula string
  seconds_today  INTEGER NOT NULL DEFAULT 0,
  seconds_total  INTEGER NOT NULL DEFAULT 0,
  updated        TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_deadline ON task_snapshot (deadline)
  WHERE deadline IS NOT NULL;

CREATE TABLE IF NOT EXISTS timer_snapshot (
  notion_id       TEXT PRIMARY KEY,
  name            TEXT,
  task_id         TEXT,
  status          TEXT,    -- "Running" | "Stoped"
  start_time      TEXT,
  end_time        TEXT,
  total_seconds   INTEGER NOT NULL DEFAULT 0,
  category        TEXT,
  updated         TEXT,
  -- Highest 30-minute bucket already emailed for a running timer (rule E2).
  -- Persisted so a redeploy cannot replay buckets.
  notified_bucket INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_timer_status ON timer_snapshot (status);

-- Pre-upsert timer state, written by the sync step before it overwrites
-- timer_snapshot. Rules E1/E3 diff the two to detect Running<->Stoped edges.
CREATE TABLE IF NOT EXISTS timer_prev (
  notion_id TEXT PRIMARY KEY,
  status    TEXT,
  end_time  TEXT,
  seen_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routine_snapshot (
  notion_id TEXT PRIMARY KEY,
  activity  TEXT,
  time      TEXT,     -- "HH:MM - HH:MM", 24-hour, bare wall-clock
  days      TEXT,     -- JSON array of weekday names
  archived  INTEGER NOT NULL DEFAULT 0,
  done      INTEGER NOT NULL DEFAULT 0,
  updated   TEXT
);

-------------------------------------------------------------------------------
-- Alert bookkeeping
-------------------------------------------------------------------------------

-- Dedupe ledger. The composite key is what makes a rule that stays true for
-- 60 consecutive ticks send exactly one email.
-- Recurring rules put a DATE in `threshold` so they re-arm the next day.
CREATE TABLE IF NOT EXISTS alerts_sent (
  rule      TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  threshold TEXT NOT NULL,
  sent_at   TEXT NOT NULL,
  PRIMARY KEY (rule, entity_id, threshold)
);

-- Audit trail. status is 'sent' | 'suppressed' | 'error: ...'.
CREATE TABLE IF NOT EXISTS alert_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  rule      TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  channel   TEXT NOT NULL,
  message   TEXT,
  status    TEXT,
  sent_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_log_sent_at ON alert_log (sent_at DESC);

-------------------------------------------------------------------------------
-- Runtime alert settings
-------------------------------------------------------------------------------
-- One row per OVERRIDDEN field. A key that is absent means "use the default
-- from wrangler.jsonc", which is what makes "reset to defaults" a plain DELETE
-- and keeps the deployed config self-documenting.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-------------------------------------------------------------------------------
-- Auth sessions (Phase 8)
-------------------------------------------------------------------------------
-- The cookie carries only the opaque `id`, HMAC-signed. This table is the
-- source of truth: deleting a row is immediate server-side revocation.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,   -- "owner" for password logins
  email        TEXT,
  workspace_id TEXT,
  name         TEXT,
  auth_method  TEXT NOT NULL DEFAULT 'password',  -- audit only; nothing branches on it
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-------------------------------------------------------------------------------
-- Phase 6: mobile push devices
-------------------------------------------------------------------------------
-- One row per installed app. `fcm_token` is the phone's push address and
-- rotates, so it is the primary key and the session id is what identifies the
-- install across rotations.
--
-- Preferences live here rather than only on the device so the Worker can skip
-- sending entirely when notifications are off — that saves the round trip and
-- the phone's radio, instead of pushing something the client throws away.
CREATE TABLE IF NOT EXISTS devices (
  fcm_token   TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  platform    TEXT,
  label       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,   -- master notification switch
  vibrate     INTEGER NOT NULL DEFAULT 1,
  quiet_start TEXT,                          -- optional per-device quiet window
  quiet_end   TEXT,
  active      INTEGER NOT NULL DEFAULT 1,    -- cleared when FCM reports UNREGISTERED
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices (active, enabled);
CREATE INDEX IF NOT EXISTS idx_devices_session ON devices (session_id);
