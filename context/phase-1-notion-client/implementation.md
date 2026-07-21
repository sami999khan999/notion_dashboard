# Phase 1 — Notion Client Layer · Implementation

This document is the build spec for `apps/worker/src/notion/`. It contains the full
source for the fetch helper, the pagination loop, the five per-DB pull functions,
the five normalizers, the TypeScript row interfaces, a reference of Notion
property-shape gotchas, a vitest testing recipe, and a pitfalls checklist.

## File layout

```
apps/worker/src/notion/
├── client.ts        # queryDb, pullAllPages, pull* functions
├── normalizers.ts   # normalizeTask/Timer/Routine/Txn/Goal
├── types.ts         # Row interfaces + Notion property helper types
└── __tests__/
    ├── normalizers.test.ts
    └── fixtures/
        ├── task.page.json
        ├── timer.page.json
        ├── routine.page.json
        ├── txn.page.json
        └── goal.page.json
```

> You may keep everything in `client.ts` as the reference snippet does; splitting
> into `types.ts` / `normalizers.ts` is recommended once all five DBs are present.

---

## 1. `Env` bindings

These come from Phase 0's Wrangler config. The client only reads them.

```ts
// apps/worker/src/notion/env.d.ts (or the shared worker Env type)
export interface Env {
  NOTION_TOKEN: string;   // secret: wrangler secret put NOTION_TOKEN
  DB_ROUTINE: string;     // 2bc82224621781b5b3d1e435e7f9dabf
  DB_TASKS: string;       // 2c082224621780738f64fe38401f8460
  DB_TIMER: string;       // 2c18222462178014a1cfdff168501bb1
  DB_TXN: string;         // cfe3d0b2968f499cbd0774e8f6c4e09f
  DB_GOALS: string;       // be4a4954aa374e57928173258a68f15a
  // ... D1 binding etc. added in later phases
}
```

---

## 2. TypeScript row interfaces (`types.ts`)

Every normalizer returns one of these. They are the public contract of the module.

```ts
// apps/worker/src/notion/types.ts

/** A raw Notion page as returned by the query endpoint. Kept `any`-ish on purpose:
 *  the whole point of the normalizers is to be the ONLY place that touches it. */
export interface NotionPage {
  id: string;
  last_edited_time: string;
  properties: Record<string, any>;
  [k: string]: any;
}

/** Shape of the /databases/{id}/query response. */
export interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface TaskRow {
  notion_id: string;
  title: string;                       // "Tasks" (title)
  category: string | null;             // "Category" (select)
  priorities: string[];                // "Priority" (multi_select)
  status: string | null;               // "Status" (status) -> "Running" | "Stoped"
  deadline: string | null;             // "Deadline" (date.start)
  date: string | null;                 // "Date" (date.start)
  completed: boolean;                  // "Completed" (checkbox)
  archive: boolean;                    // "Archive" (checkbox)
  task_progress: number | null;        // "Task Progress" (formula, READ-ONLY)
  total_seconds_today: number;         // "Total Time In Seconds Today" (rollup, READ-ONLY)
  time_tracker_ids: string[];          // "Task Time Tracker" (relation)
  routine_ids: string[];               // "Daily Routine Relation" (relation)
  updated: string;                     // page.last_edited_time
}

export interface TimerRow {
  notion_id: string;
  name: string;                        // "Name" (title)
  status: string | null;               // "Status" (status) -> "Running" | "Stoped"
  start_time: string | null;           // "Start Time" (date.start)
  end_time: string | null;             // "End Time" (date.end ?? date.start)
  total_seconds: number;               // "Total Time In Seconds" (formula, READ-ONLY)
  categories: string[];                // "Category" (multi_select)
  summery: string;                     // "Summery" (rich_text) -- SIC typo preserved
  task_id: string | null;              // "Tasks Relation" (relation[0])
  updated: string;
}

export interface RoutineRow {
  notion_id: string;
  activity: string;                    // "Activity" (title)
  time: string;                        // "Time" (rich_text)
  date: string | null;                 // "Date" (date.start)
  days: string[];                      // "Days" (multi_select)
  day_category: string[];              // "Day Cateogry" (multi_select) -- SIC typo preserved
  done: boolean;                       // "Done" (checkbox)
  active_now: boolean | null;          // "Active Now" (formula -> boolean, READ-ONLY)
  schedule_status: string | null;      // "Schedule Status" (formula -> string, READ-ONLY)
  time_remains: string | null;         // "Time Remains" (formula, READ-ONLY)
  today: boolean | null;               // "Today" (formula -> boolean, READ-ONLY)
  updated: string;
}

export interface TxnRow {
  notion_id: string;
  name: string;                        // "Name" (title)
  amount: number | null;               // "Amount" (number)
  type: string | null;                 // "Type" (select) -> "Income" | "Expense"
  date: string | null;                 // "Date" (date.start)
  category: string | null;             // "Category" (select)
  account: string | null;              // "Account" (select)
  month: string | null;                // "Month" (select)
  signed: number | null;               // "Signed" (formula, READ-ONLY)
  note: string;                        // "Note" (rich_text)
  updated: string;
}

export interface GoalRow {
  notion_id: string;
  name: string;                        // "Name" (title)
  month: string;                       // "Month" (rich_text, e.g. "2026-07")
  income_goal: number | null;          // "Income Goal" (number)
  expense_goal: number | null;         // "Expense Goal" (number)
  updated: string;
}
```

---

## 3. `client.ts` — fetch helper, pagination, pull functions

```ts
// apps/worker/src/notion/client.ts
import type { Env } from "./env";
import type { NotionPage, NotionQueryResponse } from "./types";

const NOTION = "https://api.notion.com/v1";

const HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

/**
 * Low-level query against the classic endpoint, keyed by 32-char database ID.
 * Throws on any non-2xx so failures are loud in Worker logs.
 * NOTE: 429 / rate-limit backoff is intentionally deferred to Phase 7 — this
 * helper is where that retry wrapper will eventually live.
 */
export async function queryDb(
  env: Env,
  dbId: string,
  body: object,
): Promise<NotionQueryResponse> {
  const res = await fetch(`${NOTION}/databases/${dbId}/query`, {
    method: "POST",
    headers: HEADERS(env.NOTION_TOKEN),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Notion ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as NotionQueryResponse;
}

/**
 * Drain every result page for a given query body.
 * Re-issues the same body with `start_cursor` until `has_more === false`.
 * Returns the fully accumulated array of raw Notion pages.
 */
export async function pullAllPages(
  env: Env,
  dbId: string,
  body: Record<string, unknown>,
): Promise<NotionPage[]> {
  const all: NotionPage[] = [];
  let cursor: string | null = null;

  do {
    const page = await queryDb(env, dbId, {
      ...body,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    all.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor !== null);

  return all;
}

/** Build the incremental filter body shared by every pull function. */
function incrementalBody(since: string) {
  return {
    filter: {
      timestamp: "last_edited_time",
      last_edited_time: { on_or_after: since },
    },
    page_size: 100,
  } as const;
}

// ---- Per-DB incremental pulls (return ALL pages, paginated) ----

export function pullTasks(env: Env, since: string): Promise<NotionPage[]> {
  return pullAllPages(env, env.DB_TASKS, incrementalBody(since));
}

export function pullTimer(env: Env, since: string): Promise<NotionPage[]> {
  return pullAllPages(env, env.DB_TIMER, incrementalBody(since));
}

export function pullRoutine(env: Env, since: string): Promise<NotionPage[]> {
  return pullAllPages(env, env.DB_ROUTINE, incrementalBody(since));
}

export function pullTxn(env: Env, since: string): Promise<NotionPage[]> {
  return pullAllPages(env, env.DB_TXN, incrementalBody(since));
}

export function pullGoals(env: Env, since: string): Promise<NotionPage[]> {
  return pullAllPages(env, env.DB_GOALS, incrementalBody(since));
}
```

> **Cursor note.** On the very first sync there is no stored cursor. Pass a
> far-past sentinel such as `1970-01-01T00:00:00.000Z` so the initial pull is a
> full backfill; Phase 3 then persists `max(last_edited_time)` as the next cursor.

---

## 4. `normalizers.ts` — small helpers + five normalizers

### 4.1 Shared safe readers

Every Notion property can be missing on a page (a column added after some pages
were created returns `undefined` for that property). These helpers make every read
null-safe.

```ts
// apps/worker/src/notion/normalizers.ts
import type {
  NotionPage, TaskRow, TimerRow, RoutineRow, TxnRow, GoalRow,
} from "./types";

/** title / rich_text are arrays of rich-text runs; join plain_text of all runs. */
const text = (prop: any): string =>
  (prop?.title ?? prop?.rich_text ?? [])
    .map((r: any) => r?.plain_text ?? "")
    .join("");

const checkbox = (prop: any): boolean => prop?.checkbox ?? false;

const number = (prop: any): number | null =>
  typeof prop?.number === "number" ? prop.number : null;

const selectName = (prop: any): string | null => prop?.select?.name ?? null;

const statusName = (prop: any): string | null => prop?.status?.name ?? null;

const multiNames = (prop: any): string[] =>
  (prop?.multi_select ?? []).map((o: any) => o?.name).filter(Boolean);

const dateStart = (prop: any): string | null => prop?.date?.start ?? null;

/** End Time: prefer the range end, fall back to start (single-instant dates). */
const dateEnd = (prop: any): string | null =>
  prop?.date?.end ?? prop?.date?.start ?? null;

const relationIds = (prop: any): string[] =>
  (prop?.relation ?? []).map((r: any) => r?.id).filter(Boolean);

const firstRelationId = (prop: any): string | null =>
  prop?.relation?.[0]?.id ?? null;

/** Formula results carry a type discriminator: number | boolean | string | date. */
const formulaNumber = (prop: any): number | null =>
  typeof prop?.formula?.number === "number" ? prop.formula.number : null;

const formulaBoolean = (prop: any): boolean | null =>
  typeof prop?.formula?.boolean === "boolean" ? prop.formula.boolean : null;

const formulaString = (prop: any): string | null =>
  prop?.formula?.string ?? null;

/** Rollup can be number | array | date depending on the aggregation. */
const rollupNumber = (prop: any): number =>
  typeof prop?.rollup?.number === "number" ? prop.rollup.number : 0;
```

### 4.2 Tasks

```ts
export function normalizeTask(page: NotionPage): TaskRow {
  const p = page.properties;
  return {
    notion_id: page.id,
    title: text(p["Tasks"]),
    category: selectName(p["Category"]),
    priorities: multiNames(p["Priority"]),
    status: statusName(p["Status"]),                         // "Running" | "Stoped"
    deadline: dateStart(p["Deadline"]),
    date: dateStart(p["Date"]),
    completed: checkbox(p["Completed"]),
    archive: checkbox(p["Archive"]),
    task_progress: formulaNumber(p["Task Progress"]),        // READ-ONLY formula
    total_seconds_today: rollupNumber(p["Total Time In Seconds Today"]), // READ-ONLY rollup
    time_tracker_ids: relationIds(p["Task Time Tracker"]),
    routine_ids: relationIds(p["Daily Routine Relation"]),
    updated: page.last_edited_time,
  };
}
```

### 4.3 Time Tracker

```ts
export function normalizeTimer(page: NotionPage): TimerRow {
  const p = page.properties;
  return {
    notion_id: page.id,
    name: text(p["Name"]),
    status: statusName(p["Status"]),                         // "Running" | "Stoped"
    start_time: dateStart(p["Start Time"]),
    end_time: dateEnd(p["End Time"]),
    total_seconds: formulaNumber(p["Total Time In Seconds"]) ?? 0, // READ-ONLY formula
    categories: multiNames(p["Category"]),                   // multi_select here
    summery: text(p["Summery"]),                             // SIC: "Summery" typo
    task_id: firstRelationId(p["Tasks Relation"]),
    updated: page.last_edited_time,
  };
}
```

### 4.4 Daily Routine

```ts
export function normalizeRoutine(page: NotionPage): RoutineRow {
  const p = page.properties;
  return {
    notion_id: page.id,
    activity: text(p["Activity"]),
    time: text(p["Time"]),                                   // rich_text, not a date
    date: dateStart(p["Date"]),
    days: multiNames(p["Days"]),
    day_category: multiNames(p["Day Cateogry"]),             // SIC: "Cateogry" typo
    done: checkbox(p["Done"]),
    active_now: formulaBoolean(p["Active Now"]),             // READ-ONLY formula->boolean
    schedule_status: formulaString(p["Schedule Status"]),    // READ-ONLY formula->string
    time_remains: formulaString(p["Time Remains"]),          // READ-ONLY formula
    today: formulaBoolean(p["Today"]),                       // READ-ONLY formula->boolean
    updated: page.last_edited_time,
  };
}
```

### 4.5 Transactions

```ts
export function normalizeTxn(page: NotionPage): TxnRow {
  const p = page.properties;
  return {
    notion_id: page.id,
    name: text(p["Name"]),
    amount: number(p["Amount"]),
    type: selectName(p["Type"]),                             // "Income" | "Expense"
    date: dateStart(p["Date"]),
    category: selectName(p["Category"]),                     // select, not multi
    account: selectName(p["Account"]),
    month: selectName(p["Month"]),                           // select here (Goals differs)
    signed: formulaNumber(p["Signed"]),                      // READ-ONLY formula
    note: text(p["Note"]),
    updated: page.last_edited_time,
  };
}
```

### 4.6 Goals

```ts
export function normalizeGoal(page: NotionPage): GoalRow {
  const p = page.properties;
  return {
    notion_id: page.id,
    name: text(p["Name"]),
    month: text(p["Month"]),                                 // rich_text "2026-07" (NOT select)
    income_goal: number(p["Income Goal"]),
    expense_goal: number(p["Expense Goal"]),
    updated: page.last_edited_time,
  };
}
```

---

## 5. Notion property-shape gotchas

The verbose property shapes are the source of nearly every bug in this layer. This
table is the canonical reference; the helpers in §4.1 encode exactly these reads.

| Property type | Shape returned by Notion | Correct read | Empty / null case |
| --- | --- | --- | --- |
| `title` | `{ title: [{ plain_text }] }` | join `plain_text` of all runs | empty array → `""` |
| `rich_text` | `{ rich_text: [{ plain_text }] }` | join `plain_text` of all runs | empty array → `""` |
| `date` (start) | `{ date: { start, end } }` | `date?.start` | `date` is `null` → `null` |
| `date` (end) | `{ date: { start, end } }` | `date?.end ?? date?.start` | single-instant date has `end: null` |
| `select` | `{ select: { name } }` | `select?.name` | unset → `select` is `null` |
| `multi_select` | `{ multi_select: [{ name }] }` | map `name` | none selected → `[]` |
| `status` | `{ status: { name } }` | `status?.name` | unset → `status` is `null` |
| `checkbox` | `{ checkbox: true|false }` | `checkbox ?? false` | always present, but guard anyway |
| `number` | `{ number: 42 }` | `number` if `typeof === "number"` | empty → `number` is `null` |
| `relation` | `{ relation: [{ id }] }` | map `id`, or `[0]?.id` for single | none → `[]` / `null` |
| `formula` | `{ formula: { type, number|boolean|string|date } }` | read the branch matching `type` | wrong branch → `undefined` |
| `rollup` | `{ rollup: { type, number|array|date } }` | read the branch matching `type` | numeric rollup empty → treat as `0` |

### Key traps

- **title vs rich_text.** Both are *arrays of runs*, not strings. A cell with
  multiple styled fragments produces multiple runs — you must **join** them, not
  read `[0]` only. An empty cell is an empty array, so `[0]?.plain_text` would be
  `undefined`; join yields `""`.
- **`date.start` vs `date.end`.** A plain date/time has `end: null`. Only ranges
  populate `end`. For `End Time` we fall back to `start`.
- **relation arrays.** Always arrays. Use `relationIds` when a task can link many
  timers; use `firstRelationId` when the model expects a single parent (e.g.
  `Tasks Relation` on a timer).
- **select vs multi_select vs status.** Three *different* shapes:
  `select.name` (single object), `multi_select[].name` (array), `status.name`
  (single object, but a **read-only computed** workflow field). Note the same label
  `Category` is a **select** on Transactions but a **multi_select** on Time
  Tracker — do not copy-paste the reader between them.
- **formula branches.** `formula` is a tagged union; the value lives under
  `.number`, `.boolean`, `.string`, or `.date` according to `formula.type`. Reading
  the wrong branch yields `undefined`, not an error — hence the type-checked
  helpers.
- **rollup shapes.** A rollup can be a `number`, an `array` of sub-values, or a
  `date`. `Total Time In Seconds Today` is numeric; default to `0` when empty so
  downstream arithmetic never sees `null`.
- **`Month` is not the same type across DBs.** On **Transactions** it is a
  **select** (`selectName`); on **Goals** it is **rich_text** (`text`, e.g.
  `"2026-07"`). This is the single easiest mapping to get wrong.

---

## 6. Unit testing normalizers (vitest)

Normalizers are pure functions of a page object, so testing is capturing one real
page per DB and asserting the flattened row.

### 6.1 Capturing a fixture

Run a one-off query and save a single page's JSON into `fixtures/`.

```bash
# Capture one Tasks page (requires NOTION_TOKEN + DB id in the shell)
curl -s -X POST "https://api.notion.com/v1/databases/2c082224621780738f64fe38401f8460/query" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"page_size":1}' \
  | jq '.results[0]' > apps/worker/src/notion/__tests__/fixtures/task.page.json
```

Repeat for each DB ID (Timer, Routine, Transactions, Goals). Scrub anything
sensitive from the captured JSON before committing.

### 6.2 The test file

```ts
// apps/worker/src/notion/__tests__/normalizers.test.ts
import { describe, it, expect } from "vitest";
import {
  normalizeTask, normalizeTimer, normalizeRoutine, normalizeTxn, normalizeGoal,
} from "../normalizers";

import taskPage from "./fixtures/task.page.json";
import timerPage from "./fixtures/timer.page.json";
import routinePage from "./fixtures/routine.page.json";
import txnPage from "./fixtures/txn.page.json";
import goalPage from "./fixtures/goal.page.json";

describe("normalizers", () => {
  it("normalizeTask maps every Tasks property", () => {
    const row = normalizeTask(taskPage as any);
    expect(row.notion_id).toBe((taskPage as any).id);
    expect(typeof row.title).toBe("string");
    expect(Array.isArray(row.priorities)).toBe(true);
    expect(["Running", "Stoped", null]).toContain(row.status);
    expect(typeof row.completed).toBe("boolean");
    expect(typeof row.total_seconds_today).toBe("number"); // rollup defaults to 0
    expect(Array.isArray(row.time_tracker_ids)).toBe(true);
  });

  it("normalizeTimer maps status/start/end and the Summery typo", () => {
    const row = normalizeTimer(timerPage as any);
    expect(["Running", "Stoped", null]).toContain(row.status);
    expect(typeof row.total_seconds).toBe("number");
    expect(typeof row.summery).toBe("string"); // property key is "Summery"
    // task_id is a single relation id or null
    expect(row.task_id === null || typeof row.task_id === "string").toBe(true);
  });

  it("normalizeRoutine reads formula booleans and the Day Cateogry typo", () => {
    const row = normalizeRoutine(routinePage as any);
    expect(Array.isArray(row.day_category)).toBe(true); // key "Day Cateogry"
    expect(row.active_now === null || typeof row.active_now === "boolean").toBe(true);
    expect(row.today === null || typeof row.today === "boolean").toBe(true);
  });

  it("normalizeTxn reads select Month and formula Signed", () => {
    const row = normalizeTxn(txnPage as any);
    expect(["Income", "Expense", null]).toContain(row.type);
    expect(row.amount === null || typeof row.amount === "number").toBe(true);
    expect(row.signed === null || typeof row.signed === "number").toBe(true);
  });

  it("normalizeGoal reads Month as rich_text", () => {
    const row = normalizeGoal(goalPage as any);
    expect(typeof row.month).toBe("string"); // e.g. "2026-07"
    expect(row.income_goal === null || typeof row.income_goal === "number").toBe(true);
  });
});
```

### 6.3 Robustness tests (nulls / empty arrays)

Add a synthetic "empty" page to prove the normalizers never throw on missing data:

```ts
it("normalizeTask survives an all-empty page", () => {
  const empty = {
    id: "x", last_edited_time: "2026-07-21T00:00:00.000Z",
    properties: {
      Tasks: { title: [] },
      Category: { select: null },
      Priority: { multi_select: [] },
      Status: { status: null },
      Deadline: { date: null },
      Date: { date: null },
      Completed: { checkbox: false },
      Archive: { checkbox: false },
      "Task Progress": { formula: { type: "number", number: null } },
      "Total Time In Seconds Today": { rollup: { type: "number", number: null } },
      "Task Time Tracker": { relation: [] },
      "Daily Routine Relation": { relation: [] },
    },
  };
  const row = normalizeTask(empty as any);
  expect(row.title).toBe("");
  expect(row.priorities).toEqual([]);
  expect(row.total_seconds_today).toBe(0);
  expect(row.time_tracker_ids).toEqual([]);
});
```

### 6.4 vitest config note

If importing `.json` fixtures triggers TS complaints, enable
`"resolveJsonModule": true` in `tsconfig.json`, or import with
`import ... assert { type: "json" }`. Vitest resolves JSON out of the box.

---

## 7. Pitfalls checklist

- [ ] **Exact-match property names, typos preserved verbatim.** These are *not*
      bugs to fix — they are the real column names in Notion:
      - `Summery` (Time Tracker rich_text) — **not** `Summary`.
      - `Day Cateogry` (Routine multi_select) — **not** `Day Category`.
      - status value `Stoped` (Tasks + Time Tracker) — **not** `Stopped`.
      A single-character mismatch reads `undefined` silently.
- [ ] **Formula / rollup / status are READ-ONLY.** Read under `.formula`,
      `.rollup`, `.status` and never send them in any write body. Notion rejects
      writes to computed properties; this phase issues no writes at all.
- [ ] **Pagination: check `has_more`, not result length.** A full 100-row page can
      still have `has_more: true`. Loop on `next_cursor` until
      `has_more === false`, re-sending the *same* filter body each time.
- [ ] **`page_size` max is 100.** Larger values are rejected.
- [ ] **`Category` differs by DB** — select on Transactions, multi_select on Time
      Tracker. **`Month` differs** — select on Transactions, rich_text on Goals.
- [ ] **Empty cells are empty arrays / null objects**, not missing keys — but a
      column added later *can* be a missing key. All reads use optional chaining +
      defaults so both cases are safe.
- [ ] **`Notion-Version: 2022-06-28`** header is mandatory on every request.
- [ ] **Integration must be shared with all 5 DBs** or the query 404s with
      `object_not_found` despite a valid ID.
- [ ] **429 / rate-limit handling is deferred to Phase 7.** For now, a 429 simply
      throws through `queryDb`; do not add retry/backoff here yet.
