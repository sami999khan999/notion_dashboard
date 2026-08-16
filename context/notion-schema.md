# Notion Schema — Verified Ground Truth

Captured live from the Notion API on **2026-08-16** using the internal integration
token. This file supersedes the property tables in `overview.md` and
`context/README.md` wherever the two disagree — several entries there were wrong,
and the corrections are called out in §7.

Everything below was read from the API, not from the Notion UI. Property names are
**exact-match, case- and typo-sensitive**.

---

## 1. Access model — the API version is not uniform

| Database | Database ID | Data-source ID | Works on `2022-06-28`? |
|---|---|---|---|
| Daily Routine Planner | `2bc82224621781b5b3d1e435e7f9dabf` | `2bc82224-6217-81a2-9b52-000b6c7526b1` | **No — 400** |
| Tasks | `2c082224621780738f64fe38401f8460` | `2c082224-6217-8061-a75e-000b079c1160` | Yes |
| Time Tracker | `2c18222462178014a1cfdff168501bb1` | `2c182224-6217-80f9-b47a-000b36ded62a` | Yes |

**Daily Routine has five data sources.** The classic endpoint refuses it:

```
400 validation_error
"Databases with multiple data sources are not supported in this API version."
```

Its data sources are:

| Data-source ID | Name | Properties |
|---|---|---|
| `2bc82224-6217-81a2-9b52-000b6c7526b1` | Daily Routine Planner Database | the real one (21 props) |
| `2bd82224-6217-8009-a49e-000b6eda4d19` | New data source | `Name` only — empty |
| `2bd82224-6217-80b7-8635-000b6c87eaa7` | New data source | `Name` only — empty |
| `2bd82224-6217-801f-ae9f-000b56c23a23` | New data source | `Name` only — empty |
| `2c082224-6217-805a-b095-000b266e6164` | New data source | `Name` only — empty |

**Consequence for the build:** pin `Notion-Version: 2025-09-03` and query
`POST /v1/data_sources/{data_source_id}/query` for *all* databases, not the
classic `POST /v1/databases/{id}/query`. Using one endpoint everywhere is simpler
than special-casing routine, and the classic path is a dead end the moment any
other database gains a second data source.

The four empty data sources look like accidental Notion UI artifacts. Deleting
them in Notion would let the classic endpoint work again, but the data-source
endpoint is the forward-compatible choice regardless.

---

## 2. Daily Routine Planner

Data source `2bc82224-6217-81a2-9b52-000b6c7526b1`. **183 pages, 163 archived → 20 active.**

| Property | Type | Notes |
|---|---|---|
| `Activity` | title | e.g. `Work`, `Break`, `Sleep` |
| `Time` | **rich_text** | `"HH:MM - HH:MM"`, 24-hour. All 183 rows conform exactly — zero malformed values |
| `Days` | multi_select | `Saturday`…`Friday`. This is what makes a block recur |
| `Day Cateogry` | multi_select *(sic)* | `Week Day`, `Every Day`, `Week End` |
| `Date` | date | **Empty on all 183 rows** — routine is purely weekly, never date-pinned |
| `Done` | checkbox | |
| `Archive` | checkbox | 163 of 183 are archived |
| `Active Now` | formula → **string** | `"🟢 Active"` / `"🟡 Starting Soon"` / `"🔴 Inactive"` |
| `Today` | formula → **string** | `"🟢 Monday"` / `"🔴 Monday"` |
| `Today Check` | formula → **boolean** | true when today ∈ `Days` |
| `Time Check` | formula → boolean | hour-bucket helper, buggy for non-hour boundaries |
| `Schedule Status` | formula → string | `"🟢 Active Today & Tomorrow"`, `"🔴 Active 3 Days From Now"`, … |
| `Time Remains` | formula → string | `"25 min left"`, empty when not active |
| `Duration` | formula → string | `"1 hr 45 min"` |
| `12 Hour Time` | formula → string | `"10:10 PM - 11:55 PM"` |
| `Category` | rollup (show_original) | from `Tasks Relation` |
| `Tasks Relation` | relation → Tasks | dual, synced with `Daily Routine Relation` |
| `Sub-item` / `Parent item` | relation (self) | **unused — 0 rows have a parent** |
| `Place` | place | unused |
| `ID` | unique_id | |

### The 20 active blocks

All 20 are `Days = Sun,Mon,Tue,Wed,Thu` and `Day Cateogry = Week Day`. They tile a
complete 24-hour day with no gaps and no overlaps:

```
00:00-00:30 Break        08:45-09:00 Break        19:30-19:35 Exercise
00:30-01:30 Work         09:00-13:00 Work         19:35-20:00 Break
01:30-02:00 Break        13:00-14:00 Break        20:00-20:20 English Speaking Practice
02:00-07:45 Sleep        14:00-16:30 Work         20:20-21:50 Gaming
07:45-08:15 Get Fresh    16:30-17:00 Break        21:50-22:10 Study
08:15-08:45 Travel       17:00-18:30 Work         22:10-23:55 Work
                                                  23:55-00:00 Exercise
```

**Friday and Saturday have zero active blocks** — every Fri/Sat row is archived.
No routine emails will fire on those two days.

`23:55 - 00:00` is the only block whose end time is not strictly greater than its
start in wall-clock terms once it wraps; `02:00 - 07:45` and the rest are
same-day. Overnight-spanning logic still has to exist because the `Active Now`
formula supports it and a future block could use it.

---

## 3. Tasks

Data source `2c082224-6217-8061-a75e-000b079c1160`. **359 pages** — 180 completed,
51 archived, **3 with a `Deadline`**.

| Property | Type | Notes |
|---|---|---|
| `Tasks` | title | |
| `Status` | status | `Stoped` / `Running`. Groups: To-do=[Stoped], In progress=[Running], Complete=[] |
| `Deadline` | date | **Only 3 rows populated.** Mixed precision — see below |
| `Date` | date | |
| `Completed` | checkbox | |
| `Archive` | checkbox | |
| `Category` | select | 18 options incl. `Project`, `Study`, `Purchase`, `AI` |
| `Priority` | multi_select | `Low`, `Medium`, `High` |
| `Tags` | multi_select | 22 project names |
| `Topic` | multi_select | 5 options |
| `Task Progress` | formula → string | `"Could not finish within deadline"`, `"Finished within deadline (…)"`, `""` |
| `Finished At` | formula → date | `if(Completed, Last Edited Time, empty)` |
| `Active Now` | **rollup (show_original)** | array, from `Daily Routine Relation` — **not** a formula |
| `Total Time In Seconds Today` | rollup sum | over `Task Time Tracker` |
| `Total Time In Seconds` / `7/15/30 Days` / `Yesterday` | rollup sum | plus matching `Total Time*` string formulas |
| `Task Time Tracker` | relation → Time Tracker | dual |
| `Daily Routine Relation` | relation → Daily Routine | dual |
| `Project Plans ` | relation | **note the trailing space in the name** |
| `Start`, `Pause` | **button** | see §6 |
| `Order` | number | |
| `Resource` | rich_text | |
| `ID` | unique_id | |
| `Last edited time` | last_edited_time | |

### Deadline precision is mixed — and all three are archived

| Task | Deadline value | Precision | `Completed` | `Archive` |
|---|---|---|---|---|
| Google OAuth in react native | `2026-03-31T00:00:00.000+06:00` | datetime | no | **yes** |
| Learn Nest JS | `2026-02-22` | **date-only** | no | **yes** |
| React Native | `2026-02-01T12:00:00.000+06:00` | datetime | yes | **yes** |

A date-only deadline has no time component, so "1 hour before the deadline" is
undefined for it. The alert engine must branch on `deadline.length === 10`.

**Every task that has a deadline today is archived**, so the deadline rules
(E4–E7) correctly produce nothing right now — confirmed against the live mirror.
The family only starts doing work once a *non-archived* task gets a deadline.
Worth knowing before concluding the rules are broken.

### `Status` is dead data

**All 359 tasks are `Stoped`.** Not one is `Running`. Whatever "a task is running"
means operationally, it is *not* recorded in this field — it lives in Time Tracker.
Any rule keyed on `Tasks.Status = Running` would never fire. Use an open
Time Tracker row joined via `Task Time Tracker` instead.

---

## 4. Time Tracker

Data source `2c182224-6217-80f9-b47a-000b36ded62a`. **162 pages**, all `Stoped`,
all with an `End Time`. No orphan timers at capture time.

| Property | Type | Notes |
|---|---|---|
| `Name` | title | |
| `Status` | status | `Stoped` / `Running` — **groups are miswired, see below** |
| `Start Time` | date (datetime) | always `+06:00` |
| `End Time` | date (datetime) | always `+06:00` |
| `Total Time In Seconds` | formula → number | `dateBetween(End, Start, "seconds")`, **0 when either is empty** |
| `Total Time In Seconds Today` | formula → number | splits overnight sessions at midnight |
| `Total Time In Seconds Yesterday` / `7/15/30 Days` | formula → number | |
| `Total Time`, `Total Time Today` | formula → string | `"1h 45m 30s"` |
| `Day` | formula → string | `"🟦 Sunday"` |
| `Category` | multi_select | 17 options |
| `Priority` | multi_select | `Low`, `Medium`, `High` |
| `Summery` | rich_text *(sic)* | empty on every sampled row |
| `Tasks Relation` | relation → Tasks | dual |
| `ID` | unique_id | |
| `Last edited time` | last_edited_time | |

### The `Status` groups are wrong

```
To-do       → [Stoped]
In progress → []            ← empty
Complete    → [Running]     ← "Running" is grouped under Complete
```

The *option values* are fine and `filter: {property:"Status", status:{equals:"Running"}}`
works correctly. But any Notion **board view grouped by status**, or any API filter
using `status.group`, will treat a running timer as "Complete". Filter on the
option name, never the group. (Tasks has the same two options grouped correctly,
which makes the inconsistency easy to trip over.)

### A running timer has `Total Time In Seconds = 0`

The formula guards on `and(Start Time, End Time)` and returns `0` otherwise. So an
in-flight timer reports zero elapsed, not partial elapsed. Live elapsed time must
be computed as `now − Start Time` in our own code.

---

## 5. Time zone

**Every** datetime in Time Tracker carries offset `+06:00` — 162/162 rows. That is
**Asia/Dhaka**, which has no DST, so a fixed `+06:00` offset is safe year-round.

Routine `Time` strings are bare wall-clock (`"09:00 - 13:00"`) with no zone, and
Notion's `Active Now` formula evaluates them against the *viewer's* local time.
Our Worker runs in UTC, so it must explicitly interpret routine times as
Asia/Dhaka. Set `ALERT_TZ=Asia/Dhaka` and resolve every day boundary, routine
window, and "today" through it. Getting this wrong shifts every routine email by
six hours.

---

## 6. Buttons are invisible to the API

`Tasks.Start` and `Tasks.Pause` are `button` properties. The API **cannot read
their configuration and cannot press them.** They are presumably Notion button
automations that create a Time Tracker row and flip `Status`.

This matters for the dashboard: a "Start timer" control in our UI cannot delegate
to the existing button. It would have to replicate the button's effect —
create a Time Tracker page with `Start Time = now`, `Status = Running`, and a
`Tasks Relation` back-link. That is writable via the API, but it is a
reimplementation, and if the Notion button's behaviour ever changes the two drift
apart.

**Recommendation:** keep the dashboard read-only for now. Start/stop stays in
Notion, where the buttons already work; the dashboard and email alerts observe.

---

## 7. Corrections to the existing plan documents

These are errors in `overview.md` / `context/README.md`, not just omissions:

| # | Document says | Actually |
|---|---|---|
| 1 | Pin `Notion-Version: 2022-06-28`, query by 32-char database ID | Daily Routine **400s** on that version — it has 5 data sources. Must use `2025-09-03` + data-source endpoint |
| 2 | Routine `Active Now` is a `formula → boolean` | It is a **formula → string** (`"🟢 Active"` / `"🟡 Starting Soon"` / `"🔴 Inactive"`). A truthiness check on it is always true |
| 3 | Tasks `Active Now` is a formula | It is a **rollup** returning an **array** |
| 4 | Routine `Today` is a formula (implied boolean) | `Today` is a **string**; the boolean is the separate `Today Check` |
| 5 | Tasks `Status` → `Running`/`Stoped` is usable state | All 359 rows are `Stoped`; the field is unused |
| 6 | Timer `Total Time In Seconds` gives elapsed time | It is **0** while a timer runs |
| 7 | `Summery` is on Time Tracker (correct) but listed as populated | Empty on every row sampled |
| 8 | Routine has a usable `Date` | Empty on all 183 rows; recurrence is via `Days` only |

### The incremental-cursor bug this exposes

The plan's sync strategy is an incremental pull filtered on
`last_edited_time >= cursor`. **Notion formulas are computed at read time and do
not bump `last_edited_time`.** When `Active Now` flips from `"🔴 Inactive"` to
`"🟢 Active"` at 09:00, *nothing about the page changes* from the API's
perspective — the row will not appear in an incremental pull, and the
routine-start alert will never fire.

`Total Time In Seconds Today` has the same property: it changes as the day passes
without any edit event.

Two consequences:

1. **Never derive an edge-triggered alert from a Notion formula.** Compute routine
   activation locally from `Time` + `Days` + `ALERT_TZ`. This is deterministic,
   testable, gives exact minute-level boundaries, and removes the dependency on
   Notion's notion of "now".
2. **Routine does not need incremental sync at all.** 20 active rows is one
   unfiltered query per tick. Keep the `last_edited_time` cursor for Tasks (359)
   and Time Tracker (162), where it genuinely saves work.

Also note `last_edited_time` has **minute granularity** — every observed value ends
in `:00.000`. With a 1-minute cron, detection of a new timer lands 1–2 minutes
after the edit. That is the floor on "timer started" email latency, and no amount
of cron tuning improves it.

---

## 8. Reproducing this capture

```bash
curl -s -X POST https://api.notion.com/v1/data_sources/<data_source_id>/query \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{"page_size":5}'
```

Retrieve a database's data-source list with
`GET /v1/databases/<database_id>` on `Notion-Version: 2025-09-03`.
