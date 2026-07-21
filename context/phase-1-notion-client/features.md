# Phase 1 — Notion Client Layer · Features

This phase delivers the capabilities that let the Worker read Notion reliably and
turn its verbose JSON into flat, typed rows. Each capability below is described in
terms of *what it does*, *why it is shaped that way*, and *how it feeds later
phases* (especially the Phase 4 alert rules).

---

## 1. Low-level `queryDb` fetch helper

A single function that owns the HTTP contract with Notion.

- POSTs to the **classic** endpoint `https://api.notion.com/v1/databases/{id}/query`,
  keyed by the 32-character database ID.
- Sends the required headers on every call:
  - `Authorization: Bearer <NOTION_TOKEN>`
  - `Notion-Version: 2022-06-28`
  - `Content-Type: application/json`
- **Error handling:** any non-2xx response throws
  `Error("Notion <status>: <body>")`, surfacing the status code and Notion's JSON
  error body (which contains `code` and `message`). This makes failures loud and
  debuggable in Worker logs rather than silently returning `undefined`.
- Returns the parsed JSON response object (`results`, `has_more`, `next_cursor`).

**Why it matters later:** every pull function and every future write goes through
this one choke point, so the auth header, API version, and error semantics are
defined in exactly one place. Rate-limit (429) handling is intentionally *not*
here yet — it is deferred to Phase 7, where retry/backoff wraps this helper.

## 2. Incremental, cursor-based pulls

Each database has a `pull*(env, since)` function that issues a query filtered by
`last_edited_time`:

```ts
filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } }
```

- `since` is an ISO-8601 timestamp — the cursor from the previous successful sync
  (stored in D1 in Phase 3). On first run it is a far-past sentinel (e.g.
  `1970-01-01T00:00:00.000Z`) so the initial pull is a full backfill.
- Only pages **edited on or after** the cursor come back, so steady-state syncs
  move a handful of rows instead of the entire database — critical for staying
  inside the Worker CPU budget and Notion's rate limits.
- `page_size: 100` (Notion's maximum) minimizes round trips.

**Why it matters later:** Phase 3's cron reads the last cursor, calls each `pull*`,
upserts the deltas, then advances the cursor to the max `last_edited_time` seen.
The incremental contract is what makes a frequent cron affordable.

## 3. Full pagination (`pullAllPages`)

A generic loop that drains a query across all result pages.

- Calls `queryDb`, appends `results`, and if `has_more === true` re-issues the
  same query with `start_cursor: next_cursor`.
- Stops only when `has_more === false`, returning the fully accumulated array of
  raw Notion pages.
- Works for any DB because the filter body is passed in; the per-DB `pull*`
  functions supply the `last_edited_time` filter and delegate paging to it.

**Why it matters later:** without draining pages, a backfill or a large edit batch
would silently truncate at 100 rows and D1 would drift out of sync with Notion —
a data-integrity bug that is hard to notice.

## 4. Five typed normalizers

One normalizer per database converts a raw Notion page into a flat row. Each maps
**every** property listed in the project spec, reading the correct nested shape and
handling nulls/empty arrays defensively.

| Normalizer | Source DB | Produces | Notable fields |
| --- | --- | --- | --- |
| `normalizeTask` | Tasks | `TaskRow` | `status` (`Running`/`Stoped`), `task_progress` (formula), `total_seconds_today` (rollup), relation IDs |
| `normalizeTimer` | Time Tracker | `TimerRow` | `status`, `start_time`, `end_time`, `total_seconds` (formula), `task_id` (relation) |
| `normalizeRoutine` | Daily Routine | `RoutineRow` | `active_now`/`today` (formula→boolean), `Day Cateogry` (typo), formula strings |
| `normalizeTxn` | Transactions | `TxnRow` | `amount`, `type` (`Income`/`Expense`), `signed` (formula), select fields |
| `normalizeGoal` | Goals | `GoalRow` | `month` (rich_text `2026-07`), `income_goal`, `expense_goal` |

- **Read-only fields** (`formula`, `rollup`, `status`) are read under their
  respective keys and never written back.
- **Exact-match property names** are used verbatim, *including the source typos*:
  `Summery` (Time Tracker rich_text), `Day Cateogry` (Routine multi_select), and
  the status value `Stoped`.

**Why it matters later:** the flat rows are the schema the whole app agrees on. D1
tables mirror these rows, SSR views bind to them, and alert rules read their
fields by name.

## 5. TypeScript row types

Every normalizer has an exported interface (`TaskRow`, `TimerRow`, `RoutineRow`,
`TxnRow`, `GoalRow`). These are the module's public contract:

- They make the D1 schema and the alert logic type-check against the same shapes.
- They eliminate `any` from downstream code — a renamed or removed Notion property
  becomes a compile error in exactly one place.

## 6. Unit-testable normalizers

Because normalizers are pure functions of a page object, they are tested with
**vitest** against a captured sample page JSON per database. This satisfies the
exit criterion and locks the property mapping (typos included) against regressions.

---

## How each capability feeds Phase 4 alert rules

The normalized rows are engineered to make later alert rules trivial reads rather
than JSON spelunking. Examples:

| Alert rule (Phase 4) | Reads from this layer |
| --- | --- |
| **Orphan timer** — a timer left running | `TimerRow.status === "Running"` and `TimerRow.start_time` (flag if running far in the past). |
| **Overdue task** | `TaskRow.deadline`, `TaskRow.completed`, `TaskRow.status`. |
| **Missed routine** | `RoutineRow.today === true`, `RoutineRow.active_now`, `RoutineRow.done`, `RoutineRow.schedule_status`. |
| **Budget overrun** | `TxnRow.amount` / `TxnRow.type` / `TxnRow.month` aggregated against `GoalRow.income_goal` / `GoalRow.expense_goal` for the matching `GoalRow.month`. |
| **Task time roll-up sanity** | `TaskRow.total_seconds_today` (rollup) vs summed `TimerRow.total_seconds` for the day. |

Because `status`, `start_time`, formula booleans (`active_now`, `today`), and
numbers (`signed`, `total_seconds`) are already flattened and typed, the rules read
one field instead of walking Notion's property tree — and they never risk writing
to a read-only computed field.
