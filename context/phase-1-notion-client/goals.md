# Phase 1 — Notion Client Layer · Goals

## Objective

Build a **thin, typed Notion client** that lives in `apps/worker/src/notion/` and is
the single point of contact between the Cloudflare Worker and the Notion API. This
layer does three things and nothing more:

1. **Talks to Notion** through one low-level `fetch` helper (`queryDb`) that sets the
   correct headers (`Notion-Version: 2022-06-28`), targets the classic
   `/v1/databases/{id}/query` endpoint, and turns non-2xx responses into thrown
   errors.
2. **Pulls incrementally** — every per-database pull function filters on
   `last_edited_time` with `on_or_after: <cursor>` and walks every result page via
   `next_cursor` until `has_more === false`.
3. **Normalizes** Notion's deeply nested property shapes into **flat, typed rows**
   that the rest of the app (D1 upserts in Phase 3, alert rules, SSR views) can
   consume without ever touching a `.title[0].plain_text` chain again.

The client is intentionally **stateless and side-effect-free** apart from the HTTP
call itself. It does not write to D1, it does not schedule anything, it does not
know about FCM. It converts *Notion pages* → *typed rows*. Everything downstream
depends on the row types being stable and correct, so correctness of the
normalizers is the whole game in this phase.

### Scope boundaries

| In scope (Phase 1) | Out of scope (later phases) |
| --- | --- |
| `queryDb` fetch helper | Writing rows to D1 (Phase 3) |
| `pullAllPages` pagination loop | Cron scheduling / `scheduled()` (Phase 3) |
| Five per-DB incremental pull functions | Alert rule evaluation (Phase 4) |
| Five per-DB normalizers → flat rows | FCM push (Phase 5) |
| TypeScript row interfaces | Flutter mobile client (Phase 6) |
| Unit tests for normalizers | 429 / rate-limit backoff (Phase 7) |

> **Read-only rule.** Formula, rollup, and status properties are **computed by
> Notion** and are never written back. This phase only *reads* them (under
> `.formula`, `.rollup`, `.status`). No write/update endpoints are implemented at
> all in Phase 1.

## Exit Criteria Checklist

- [ ] **Tasks** DB pulls incrementally (`last_edited_time` filter) and normalizes to a typed `TaskRow`.
- [ ] **Time Tracker** DB pulls incrementally and normalizes to a typed `TimerRow`.
- [ ] **Daily Routine** DB pulls incrementally and normalizes to a typed `RoutineRow`.
- [ ] **Transactions** DB pulls incrementally and normalizes to a typed `TxnRow`.
- [ ] **Goals** DB pulls incrementally and normalizes to a typed `GoalRow`.
- [ ] `pullAllPages` follows `next_cursor` until `has_more === false` (verified with a paginated fixture).
- [ ] Every normalizer handles **nulls and empty arrays** without throwing (empty title, missing date, empty relation).
- [ ] Formula / rollup / status fields are read under `.formula` / `.rollup` / `.status` and never written.
- [ ] Exact property names — **including the typos** `Summery`, `Day Cateogry`, and the status value `Stoped` — are matched verbatim.
- [ ] **Vitest** unit tests pass: one captured sample page per DB (5 tests minimum) asserting the normalized row shape.
- [ ] TypeScript compiles with no `any` leaking out of the module's public surface (row interfaces are exported and used).

## Dependencies

This phase cannot start until the following are in place.

| Dependency | Source | Why it's needed |
| --- | --- | --- |
| **Phase 0 scaffold** | Phase 0 | `apps/worker` exists, `Env` type is defined, Wrangler config binds the DB ID env vars. |
| **`NOTION_TOKEN` secret** | `wrangler secret put NOTION_TOKEN` | The internal integration token used in the `Authorization: Bearer` header. |
| **Notion integration shared with all 5 databases** | Notion UI → each DB → *Connections* | The integration must be explicitly connected to **every** database (Routine, Tasks, Timer, Transactions, Goals). A token that is not shared with a DB returns `404 object_not_found` even though the ID is correct. |
| **Database IDs as env vars** | Phase 0 Wrangler vars | `DB_ROUTINE`, `DB_TASKS`, `DB_TIMER`, `DB_TXN`, `DB_GOALS` (32-char classic IDs). |

### Database ID reference

| Env var | Database | ID |
| --- | --- | --- |
| `DB_ROUTINE` | Daily Routine | `2bc82224621781b5b3d1e435e7f9dabf` |
| `DB_TASKS` | Tasks | `2c082224621780738f64fe38401f8460` |
| `DB_TIMER` | Time Tracker | `2c18222462178014a1cfdff168501bb1` |
| `DB_TXN` | Transactions | `cfe3d0b2968f499cbd0774e8f6c4e09f` |
| `DB_GOALS` | Goals | `be4a4954aa374e57928173258a68f15a` |

## What This Unblocks

- **Phase 3 — Incremental sync.** The `scheduled()` cron handler calls each
  `pull*` function with the stored `last_edited_time` cursor, then upserts the
  normalized rows into D1. Phase 3 depends entirely on the row types and the
  pagination guarantee defined here.
- **Phase 4 — Alert rules** consume the flat rows (e.g. the orphan-timer rule reads
  `TimerRow.status === "Running"` and `TimerRow.start_time`).
- **Phase 5 — FCM** and **Phase 6 — mobile** ultimately render the same normalized
  data that originates in this layer.

## Effort

**~1 day.** The fetch helper and pagination loop are small. The bulk of the time is
writing five careful normalizers and their fixture-based tests, and verifying the
exact property names (typos included) against real captured pages.
