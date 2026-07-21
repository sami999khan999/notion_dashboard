# Phase 3 — Sync Engine · Implementation

This document contains the full implementation of the sync engine: the Worker default
export, the `runSync` orchestrator, cursor helpers, generic pagination, and the five
per-DB batch upserts. It ends with the sync sequence diagram, local cron-trigger
instructions for Windows/PowerShell, an exit-criteria verification map, and pitfalls.

All code lives under `apps/worker/src/sync/` and consumes the Phase 1 Notion client and
Phase 2 D1 schema. All timestamps are ISO 8601 UTC.

---

## File layout

```
apps/worker/src/
  index.ts            # default export: scheduled() + fetch
  sync/
    run.ts            # runSync orchestrator
    cursor.ts         # getCursor / setCursor over sync_state
    pull.ts           # pullAllPages generic pagination
    upserts.ts        # upsertTasks / upsertTimers / upsertRoutine / upsertTxns / upsertGoals
    alerts.ts         # runAlertRules stub (implemented in Phase 4)
```

---

## Environment bindings

```ts
// apps/worker/src/env.ts
export interface Env {
  // D1
  DB: D1Database;

  // Notion API
  NOTION_TOKEN: string;

  // Notion database ids
  DB_ROUTINE: string;
  DB_TASKS: string;
  DB_TIMER: string;
  DB_TXN: string;
  DB_GOALS: string;
}

/** The five logical databases the engine syncs. */
export type DbKey = "tasks" | "timers" | "routine" | "txns" | "goals";

/** Maps a logical DB key to the env var holding its Notion database id. */
export const DB_ENV_ID: Record<DbKey, keyof Env> = {
  tasks: "DB_TASKS",
  timers: "DB_TIMER",
  routine: "DB_ROUTINE",
  txns: "DB_TXN",
  goals: "DB_GOALS",
};
```

---

## Worker default export (`scheduled` + `fetch`)

The cron trigger calls `scheduled()`. We wrap the pipeline in `ctx.waitUntil` so the
runtime keeps the invocation alive until the sync completes; without it the Worker could
be torn down mid-sync. HTTP traffic is delegated to the TanStack Start handler.

```ts
// apps/worker/src/index.ts
import type { Env } from "./env";
import { runSync } from "./sync/run";
import { startHandler } from "./start"; // TanStack Start request handler

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Keep the invocation alive until the full sync resolves.
    ctx.waitUntil(runSync(env));
  },

  fetch: startHandler,
};
```

---

## `runSync` orchestrator

`runSync` runs the five-step pipeline for each database. Note the **ordering** for
routines: previous `active_now` is captured *before* the upsert overwrites it, then
handed to the alert stage.

```ts
// apps/worker/src/sync/run.ts
import type { Env } from "../env";
import { getCursor, setCursor } from "./cursor";
import { pullAllPages } from "./pull";
import {
  upsertTasks,
  upsertTimers,
  upsertRoutine,
  upsertTxns,
  upsertGoals,
  getPreviousRoutineActive,
} from "./upserts";
import { runAlertRules } from "./alerts";
import {
  normalizeTask,
  normalizeTimer,
  normalizeRoutine,
  normalizeTxn,
  normalizeGoal,
} from "../notion/normalizers"; // Phase 1

export async function runSync(env: Env): Promise<void> {
  // A single "now" for the whole run; used to advance every cursor consistently.
  const runStartedAt = new Date().toISOString();

  // --- tasks -------------------------------------------------------------
  {
    const since = await getCursor(env, "tasks");
    const pages = await pullAllPages(env, "tasks", since);
    await upsertTasks(env, pages.map(normalizeTask));
    await setCursor(env, "tasks", runStartedAt);
  }

  // --- timers ------------------------------------------------------------
  {
    const since = await getCursor(env, "timers");
    const pages = await pullAllPages(env, "timers", since);
    await upsertTimers(env, pages.map(normalizeTimer));
    await setCursor(env, "timers", runStartedAt);
  }

  // --- routine (edge-trigger prep) --------------------------------------
  //
  // ORDERING REQUIREMENT for Phase 4 A4 (routine start):
  // We MUST read the previous `active_now` from the snapshot BEFORE upserting,
  // otherwise the old value is gone and false->true transitions can't be detected.
  {
    const since = await getCursor(env, "routine");
    const pages = await pullAllPages(env, "routine", since);
    const rows = pages.map(normalizeRoutine);

    // 1. Capture previous active_now keyed by notion_id (pre-upsert).
    const prevActive = await getPreviousRoutineActive(
      env,
      rows.map((r) => r.notion_id),
    );

    // 2. Upsert the new snapshot (this overwrites active_now).
    await upsertRoutine(env, rows);

    // 3. Stash prevActive so runAlertRules can compare prev vs new.
    //    (Phase 4 will read this; for now it is passed through.)
    (env as any).__prevRoutineActive = prevActive;
    await setCursor(env, "routine", runStartedAt);
  }

  // --- txns --------------------------------------------------------------
  {
    const since = await getCursor(env, "txns");
    const pages = await pullAllPages(env, "txns", since);
    await upsertTxns(env, pages.map(normalizeTxn));
    await setCursor(env, "txns", runStartedAt);
  }

  // --- goals -------------------------------------------------------------
  {
    const since = await getCursor(env, "goals");
    const pages = await pullAllPages(env, "goals", since);
    await upsertGoals(env, pages.map(normalizeGoal));
    await setCursor(env, "goals", runStartedAt);
  }

  // --- alerts (Phase 4; stubbed here) -----------------------------------
  await runAlertRules(env);
}
```

> **Note on `__prevRoutineActive`.** This ad-hoc pass-through is a Phase-3 placeholder so
> the ordering is demonstrable now. Phase 4 will replace it with a typed argument to
> `runAlertRules(env, { prevRoutineActive })`. The *ordering* — capture, upsert, alert —
> is the load-bearing part and must not change.

---

## Cursor helpers (`sync_state`)

Cursors live in the Phase 2 `sync_state` key/value table under keys like `cursor:tasks`.
On first run (no row yet) we return a far-past date so the initial sync backfills
everything; every run thereafter is incremental.

```ts
// apps/worker/src/sync/cursor.ts
import type { Env, DbKey } from "../env";

/** Far-past sentinel used on first run so the initial sync backfills everything. */
const EPOCH = "1970-01-01T00:00:00.000Z";

const key = (db: DbKey) => `cursor:${db}`;

export async function getCursor(env: Env, db: DbKey): Promise<string> {
  const row = await env.DB
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .bind(key(db))
    .first<{ value: string }>();
  return row?.value ?? EPOCH;
}

export async function setCursor(
  env: Env,
  db: DbKey,
  iso: string,
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key(db), iso)
    .run();
}
```

---

## Generic pagination (`pullAllPages`)

`pullAllPages` works for any of the five databases. It resolves the Notion database id
from env, applies the incremental `last_edited_time` filter, and loops on `next_cursor`
until `has_more === false`.

```ts
// apps/worker/src/sync/pull.ts
import type { Env, DbKey } from "../env";
import { DB_ENV_ID } from "../env";
import { queryDb } from "../notion/client"; // Phase 1
import type { NotionPage } from "../notion/types";

/**
 * Widen the effective query start by an overlap window to avoid boundary misses
 * (Phase 7 hardening hook). Default 0 for Phase 3; Phase 7 sets ~2 minutes.
 */
const OVERLAP_MS = 0; // Phase 7: 2 * 60 * 1000

function overlappedSince(since: string): string {
  if (OVERLAP_MS === 0) return since;
  return new Date(new Date(since).getTime() - OVERLAP_MS).toISOString();
}

export async function pullAllPages(
  env: Env,
  db: DbKey,
  since: string,
): Promise<NotionPage[]> {
  const databaseId = env[DB_ENV_ID[db]] as string;
  const filter = {
    timestamp: "last_edited_time",
    last_edited_time: { on_or_after: overlappedSince(since) },
  };

  const out: NotionPage[] = [];
  let startCursor: string | undefined = undefined;

  do {
    const res = await queryDb(env, databaseId, {
      filter,
      start_cursor: startCursor,
      page_size: 100,
      sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
    });

    out.push(...res.results);
    startCursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (startCursor);

  return out;
}
```

---

## Batch upserts

Every upsert uses `env.DB.batch([...])` with a prepared
`INSERT ... ON CONFLICT(notion_id) DO UPDATE SET ...` statement per row. `notion_id` is
the conflict target on every table. All upserts are idempotent: re-processing the same
page re-writes identical values.

A shared helper keeps the batches consistent and skips empty writes.

```ts
// apps/worker/src/sync/upserts.ts
import type { Env } from "../env";
import type {
  TaskRow,
  TimerRow,
  RoutineRow,
  TxnRow,
  GoalRow,
} from "../notion/types"; // Phase 1 normalized row shapes

async function runBatch(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length === 0) return; // nothing changed this run
  await env.DB.batch(stmts);
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
export async function upsertTasks(env: Env, rows: TaskRow[]): Promise<void> {
  const sql = `
    INSERT INTO tasks
      (notion_id, title, status, priority, due_date, assignee, last_edited_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notion_id) DO UPDATE SET
      title            = excluded.title,
      status           = excluded.status,
      priority         = excluded.priority,
      due_date         = excluded.due_date,
      assignee         = excluded.assignee,
      last_edited_time = excluded.last_edited_time`;

  const stmts = rows.map((r) =>
    env.DB.prepare(sql).bind(
      r.notion_id,
      r.title,
      r.status,
      r.priority,
      r.due_date,
      r.assignee,
      r.last_edited_time,
    ),
  );
  await runBatch(env, stmts);
}

// ---------------------------------------------------------------------------
// timers
// ---------------------------------------------------------------------------
export async function upsertTimers(env: Env, rows: TimerRow[]): Promise<void> {
  const sql = `
    INSERT INTO timers
      (notion_id, label, started_at, ended_at, duration_sec, task_id, last_edited_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notion_id) DO UPDATE SET
      label            = excluded.label,
      started_at       = excluded.started_at,
      ended_at         = excluded.ended_at,
      duration_sec     = excluded.duration_sec,
      task_id          = excluded.task_id,
      last_edited_time = excluded.last_edited_time`;

  const stmts = rows.map((r) =>
    env.DB.prepare(sql).bind(
      r.notion_id,
      r.label,
      r.started_at,
      r.ended_at,
      r.duration_sec,
      r.task_id,
      r.last_edited_time,
    ),
  );
  await runBatch(env, stmts);
}

// ---------------------------------------------------------------------------
// routine
// ---------------------------------------------------------------------------
export async function upsertRoutine(
  env: Env,
  rows: RoutineRow[],
): Promise<void> {
  const sql = `
    INSERT INTO routine
      (notion_id, name, active_now, schedule, streak, last_edited_time)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(notion_id) DO UPDATE SET
      name             = excluded.name,
      active_now       = excluded.active_now,
      schedule         = excluded.schedule,
      streak           = excluded.streak,
      last_edited_time = excluded.last_edited_time`;

  const stmts = rows.map((r) =>
    env.DB.prepare(sql).bind(
      r.notion_id,
      r.name,
      r.active_now ? 1 : 0, // stored as INTEGER 0/1
      r.schedule,
      r.streak,
      r.last_edited_time,
    ),
  );
  await runBatch(env, stmts);
}

/**
 * Edge-trigger prep for Phase 4 A4 (routine start).
 *
 * Reads the PREVIOUS active_now for the given routine notion_ids from the
 * snapshot table. MUST be called BEFORE upsertRoutine so the old values are
 * still present. Returns a map notion_id -> previous active_now (boolean).
 * A routine not yet in the snapshot is treated as previously inactive (false).
 */
export async function getPreviousRoutineActive(
  env: Env,
  ids: string[],
): Promise<Map<string, boolean>> {
  const prev = new Map<string, boolean>();
  if (ids.length === 0) return prev;

  const placeholders = ids.map(() => "?").join(", ");
  const res = await env.DB
    .prepare(
      `SELECT notion_id, active_now FROM routine WHERE notion_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ notion_id: string; active_now: number }>();

  for (const row of res.results ?? []) {
    prev.set(row.notion_id, row.active_now === 1);
  }
  // Any id not returned was never seen -> previously inactive.
  for (const id of ids) if (!prev.has(id)) prev.set(id, false);
  return prev;
}

// ---------------------------------------------------------------------------
// txns
// ---------------------------------------------------------------------------
export async function upsertTxns(env: Env, rows: TxnRow[]): Promise<void> {
  const sql = `
    INSERT INTO txns
      (notion_id, description, amount, currency, category, occurred_at, last_edited_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notion_id) DO UPDATE SET
      description      = excluded.description,
      amount           = excluded.amount,
      currency         = excluded.currency,
      category         = excluded.category,
      occurred_at      = excluded.occurred_at,
      last_edited_time = excluded.last_edited_time`;

  const stmts = rows.map((r) =>
    env.DB.prepare(sql).bind(
      r.notion_id,
      r.description,
      r.amount,
      r.currency,
      r.category,
      r.occurred_at,
      r.last_edited_time,
    ),
  );
  await runBatch(env, stmts);
}

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------
export async function upsertGoals(env: Env, rows: GoalRow[]): Promise<void> {
  const sql = `
    INSERT INTO goals
      (notion_id, title, target, progress, deadline, status, last_edited_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notion_id) DO UPDATE SET
      title            = excluded.title,
      target           = excluded.target,
      progress         = excluded.progress,
      deadline         = excluded.deadline,
      status           = excluded.status,
      last_edited_time = excluded.last_edited_time`;

  const stmts = rows.map((r) =>
    env.DB.prepare(sql).bind(
      r.notion_id,
      r.title,
      r.target,
      r.progress,
      r.deadline,
      r.status,
      r.last_edited_time,
    ),
  );
  await runBatch(env, stmts);
}
```

> Column lists above are illustrative and must match the exact Phase 2 schema. The
> load-bearing invariants are: `notion_id` is the conflict target, `excluded.*` copies
> the incoming values, and booleans are stored as `0/1` integers.

---

## Alert stub (Phase 4)

`runAlertRules` is called by `runSync` but implemented in Phase 4. For Phase 3 it is a
no-op so the pipeline runs end-to-end.

```ts
// apps/worker/src/sync/alerts.ts
import type { Env } from "../env";

/**
 * Phase 4 will implement alert evaluation here, including edge-triggered rules
 * (e.g. A4 routine start) that compare the previous vs new active_now captured
 * during the routine sync. Stubbed for Phase 3.
 */
export async function runAlertRules(_env: Env): Promise<void> {
  // no-op until Phase 4
}
```

---

## Sync sequence diagram (steps 1–5)

```
  Cron (* * * * *)
        │
        ▼
  scheduled(event, env, ctx)
        │  ctx.waitUntil(runSync(env))
        ▼
  ┌──────────────────────────── runSync ────────────────────────────┐
  │  for each DB in [tasks, timers, routine, txns, goals]:           │
  │                                                                  │
  │   1. PULL      since = getCursor(env, db)          ── sync_state │
  │                pages = pullAllPages(env, db, since) ── Notion API │
  │                        (loop next_cursor until !has_more)        │
  │                                                                  │
  │   2. NORMALIZE rows = pages.map(normalizeX)        ── Phase 1    │
  │                                                                  │
  │   3. UPSERT    [routine only] prev = getPreviousRoutineActive()  │
  │                              (BEFORE upsert!)                    │
  │                upsertX(env, rows)  via env.DB.batch ── D1 snapshot│
  │                                                                  │
  │   5a. ADVANCE  setCursor(env, db, runStartedAt)    ── sync_state │
  │                                                                  │
  │  end for                                                         │
  │                                                                  │
  │   4. ALERTS    runAlertRules(env)                  ── Phase 4    │
  └──────────────────────────────────────────────────────────────────┘
```

The five conceptual steps are: **1 pull → 2 normalize → 3 upsert → 4 run alerts →
5 advance cursor**. In the implementation the cursor for each DB is advanced right after
that DB's upsert (5a), and alerts (step 4) run once at the end after all snapshots are
current — so alerts see a fully consistent mirror.

---

## Triggering a cron tick locally (Windows / PowerShell)

`wrangler dev` does not fire cron triggers on the wall clock; you invoke the scheduled
handler manually. There are two ways.

### Option A — `--test-scheduled` flag + HTTP endpoint

Start the dev server with scheduled testing enabled:

```bash
# in apps/worker
npx wrangler dev --test-scheduled
```

This exposes a special route, `/cdn-cgi/handler/scheduled`, that invokes `scheduled()`.
Hit it from a second PowerShell window:

```powershell
# fire a single cron tick against the local dev server
Invoke-RestMethod -Method Post -Uri "http://localhost:8787/cdn-cgi/handler/scheduled"
```

You can pass a specific cron spec if multiple triggers are configured:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

### Option B — curl (also available on Windows 11)

```powershell
curl.exe -X POST "http://localhost:8787/cdn-cgi/handler/scheduled"
```

> Use `curl.exe` explicitly in PowerShell — bare `curl` is an alias for
> `Invoke-WebRequest` and takes different arguments.

### Inspecting D1 locally after a tick

```bash
# read back a synced row
npx wrangler d1 execute DB --local \
  --command "SELECT notion_id, title, last_edited_time FROM tasks LIMIT 5;"

# check the cursors advanced
npx wrangler d1 execute DB --local \
  --command "SELECT key, value FROM sync_state WHERE key LIKE 'cursor:%';"
```

---

## Verification — exit criteria → checks

| Exit criterion | Check |
|----------------|-------|
| **E1** Notion edit mirrors into D1 | Edit a task's title in Notion. Fire a tick (Option A/B). Run the `SELECT ... FROM tasks` query above and confirm the new title is present. |
| **E2** Cursor advances | Run the `SELECT ... FROM sync_state WHERE key LIKE 'cursor:%'` query before and after a tick; confirm each `cursor:<db>` value moved forward to (at least) the run start time. |
| **E3** Re-run is incremental | With no further Notion edits, fire a second tick and observe (via `wrangler dev` logs / Notion query count) that only a single query per DB is issued and it returns zero pages — subrequests stay in single digits. |

Suggested log line inside `runSync` (per DB) to make E3 observable:

```ts
console.log(`[sync] ${db}: pulled ${pages.length} pages since ${since}`);
```

---

## Pitfalls

| Pitfall | Why it bites | Mitigation |
|---------|--------------|------------|
| **Subrequest limits** | A full re-pull every minute pages through all rows of all DBs and blows the Workers subrequest cap. | Incremental cursor sync — pull only `last_edited_time on_or_after` cursor. Steady state is ~1 query per DB. |
| **Cursor boundary misses** | A page edited in the same second the cursor was stored, or Notion/Worker clock skew, can fall outside the next query window and never sync. | Phase 7: rewind the query `since` by an overlap (~2 min) via `OVERLAP_MS` while still storing the true run time. Idempotent upserts make the re-processing harmless. |
| **Ordering: capture prev state before upsert** | If `upsertRoutine` runs first, the old `active_now` is overwritten and Phase 4 can never see a false→true transition (it would compare a value to itself). | `getPreviousRoutineActive` is called strictly **before** `upsertRoutine`; documented as a hard requirement in `runSync`. |
| **Non-idempotent writes** | Overlap and retries re-process pages; non-idempotent logic would duplicate or corrupt rows. | All writes are `INSERT ... ON CONFLICT(notion_id) DO UPDATE`; re-processing rewrites identical values. |
| **First-run cursor** | With no cursor, an unset `since` could pull nothing (or everything unfiltered). | `getCursor` returns a far-past epoch on first run so the initial sync backfills, then goes incremental. |
| **`waitUntil` omission** | Returning from `scheduled()` without awaiting the pipeline lets the runtime tear down the Worker mid-sync. | Always `ctx.waitUntil(runSync(env))` so the invocation stays alive until the sync resolves. |
| **Overlapping runs > 60s** | A long backfill could still be running when the next minute's tick starts, causing concurrent writes. | Phase 7: a D1 lock row guards against overlapping runs; a run that risks exceeding ~60s yields. Noted here as a hook. |
| **Booleans in D1** | D1/SQLite has no native boolean; storing `true`/`false` strings breaks comparisons. | Store `active_now` (and similar) as INTEGER `0/1`; convert at the boundary. |
| **Empty batch** | `env.DB.batch([])` on some runtimes is wasteful or errors. | `runBatch` returns early when there are no statements. |
