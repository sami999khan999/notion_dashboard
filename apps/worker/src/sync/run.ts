/**
 * Sync engine — the cron pipeline.
 *
 *   1. Snapshot previous timer state (so E1/E3 can see Running<->Stoped edges)
 *   2. Pull from Notion — incremental for Tasks + Time Tracker, FULL for routine
 *   3. Upsert into D1
 *   4. Run the alert rules against the fresh snapshot
 *   5. Advance the sync cursors
 *
 * Cursors are only advanced after a successful pull, so a failed tick retries
 * the same window a minute later rather than losing edits.
 */
import type { AppEnv } from '../env'
import { runAlertRules } from '../alerts/dispatch'
import { editedSinceFilter, queryAll } from '../notion/client'
import { normalizeRoutine, normalizeTask, normalizeTimer } from '../notion/normalize'
import type { RoutineRow, TaskRow, TimerRow } from '../notion/normalize'

/**
 * Overlap the incremental cursor by two minutes.
 *
 * Notion's `last_edited_time` has MINUTE granularity — every observed value
 * ends in :00.000. A zero-overlap cursor can therefore drop an edit that lands
 * in the same minute the cursor was written.
 */
const CURSOR_OVERLAP_MS = 2 * 60_000

/**
 * Page cap for a first-run backfill. Tasks are ~4 pages and Time Tracker ~2 at
 * 100/page, so 10 leaves plenty of headroom without risking the subrequest
 * budget.
 */
const BACKFILL_MAX_PAGES = 10

/**
 * Returns null on the very first run, which means "backfill everything".
 *
 * An initial lookback window would be wrong here: most tasks were last edited
 * months ago, so a 24h window leaves the mirror nearly empty and the deadline
 * rules blind to every pre-existing task. We pay for one full pull once, then
 * go incremental forever after.
 */
async function getCursor(env: AppEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM sync_state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

/** Incremental filter when we have a cursor, full backfill when we don't. */
function pullArgs(cursor: string | null): [Record<string, unknown>, number] {
  return cursor ? [editedSinceFilter(cursor), 10] : [{}, BACKFILL_MAX_PAGES]
}

async function setCursor(env: AppEnv, key: string, iso: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, iso, new Date().toISOString())
    .run()
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

async function upsertTasks(env: AppEnv, rows: TaskRow[]): Promise<void> {
  if (rows.length === 0) return
  const stmt = env.DB.prepare(
    `INSERT INTO task_snapshot
       (notion_id, title, status, category, deadline, date, completed, archived,
        progress, seconds_today, seconds_total, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notion_id) DO UPDATE SET
       title=excluded.title, status=excluded.status, category=excluded.category,
       deadline=excluded.deadline, date=excluded.date, completed=excluded.completed,
       archived=excluded.archived, progress=excluded.progress,
       seconds_today=excluded.seconds_today, seconds_total=excluded.seconds_total,
       updated=excluded.updated`,
  )
  await env.DB.batch(
    rows.map((r) =>
      stmt.bind(
        r.notion_id,
        r.title,
        r.status,
        r.category,
        r.deadline,
        r.date,
        r.completed,
        r.archived,
        r.progress,
        r.seconds_today,
        r.seconds_total,
        r.updated,
      ),
    ),
  )
}

async function upsertTimers(env: AppEnv, rows: TimerRow[]): Promise<void> {
  if (rows.length === 0) return
  const stmt = env.DB.prepare(
    `INSERT INTO timer_snapshot
       (notion_id, name, task_id, status, start_time, end_time, total_seconds,
        category, updated, notified_bucket)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(notion_id) DO UPDATE SET
       name=excluded.name, task_id=excluded.task_id, status=excluded.status,
       start_time=excluded.start_time, end_time=excluded.end_time,
       total_seconds=excluded.total_seconds, category=excluded.category,
       updated=excluded.updated
       -- notified_bucket deliberately NOT overwritten: it is our own E2
       -- bookkeeping and must survive every re-sync of the row.
    `,
  )
  await env.DB.batch(
    rows.map((r) =>
      stmt.bind(
        r.notion_id,
        r.name,
        r.task_id,
        r.status,
        r.start_time,
        r.end_time,
        r.total_seconds,
        r.category,
        r.updated,
      ),
    ),
  )
}

async function replaceRoutine(env: AppEnv, rows: RoutineRow[]): Promise<void> {
  if (rows.length === 0) return
  const stmt = env.DB.prepare(
    `INSERT INTO routine_snapshot
       (notion_id, activity, time, days, archived, done, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notion_id) DO UPDATE SET
       activity=excluded.activity, time=excluded.time, days=excluded.days,
       archived=excluded.archived, done=excluded.done, updated=excluded.updated`,
  )
  await env.DB.batch(
    rows.map((r) =>
      stmt.bind(
        r.notion_id,
        r.activity,
        r.time,
        JSON.stringify(r.days),
        r.archived,
        r.done,
        r.updated,
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runSync(env: AppEnv): Promise<void> {
  const startedAt = Date.now()
  const tickAt = new Date()

  try {
    // 1. Capture pre-upsert timer state for the E1/E3 edge detection.
    await env.DB.prepare(
      // The `WHERE true` is REQUIRED, not decoration. In an INSERT..SELECT with
      // an upsert clause, SQLite cannot tell whether ON CONFLICT belongs to the
      // SELECT or to the INSERT, and errors with `near "DO": syntax error`.
      // A trailing WHERE on the SELECT resolves the ambiguity.
      `INSERT INTO timer_prev (notion_id, status, end_time, seen_at)
       SELECT notion_id, status, end_time, ?
         FROM timer_snapshot
        WHERE true
       ON CONFLICT(notion_id) DO UPDATE SET
         status=excluded.status, end_time=excluded.end_time, seen_at=excluded.seen_at`,
    )
      .bind(tickAt.toISOString())
      .run()

    // 2/3. Pull + upsert.
    const taskCursor = await getCursor(env, 'tasks')
    const timerCursor = await getCursor(env, 'timer')
    const [taskFilter, taskPageCap] = pullArgs(taskCursor)
    const [timerFilter, timerPageCap] = pullArgs(timerCursor)

    const [taskPages, timerPages, routinePages] = await Promise.all([
      queryAll(env, env.DS_TASKS, taskFilter, taskPageCap),
      queryAll(env, env.DS_TIMER, timerFilter, timerPageCap),
      // Routine is pulled IN FULL every tick, deliberately. It is ~20 active
      // rows, and an incremental filter would be actively wrong here: routine
      // rows are edited rarely, so `last_edited_time` returns nothing on almost
      // every tick — but E8 needs the ROWS, not the EDITS.
      queryAll(env, env.DS_ROUTINE, {}, 3),
    ])

    await upsertTasks(env, taskPages.map(normalizeTask))
    await upsertTimers(env, timerPages.map(normalizeTimer))
    await replaceRoutine(env, routinePages.map(normalizeRoutine))

    // 4. Alerts.
    const stats = await runAlertRules(env, tickAt)

    // 5. Advance cursors — only now that everything above succeeded.
    const next = new Date(tickAt.getTime() - CURSOR_OVERLAP_MS).toISOString()
    await setCursor(env, 'tasks', next)
    await setCursor(env, 'timer', next)

    console.log(
      JSON.stringify({
        event: 'sync.ok',
        mode: taskCursor ? 'incremental' : 'backfill',
        ms: Date.now() - startedAt,
        pulled: {
          tasks: taskPages.length,
          timers: timerPages.length,
          routine: routinePages.length,
        },
        alerts: stats,
      }),
    )
  } catch (e) {
    // Cursors stay put, so the next tick retries this window.
    console.error(
      JSON.stringify({
        event: 'sync.failed',
        ms: Date.now() - startedAt,
        error: (e as Error).message,
      }),
    )
    throw e
  }
}
