# Phase 5 — Dashboard UI + Charts · Features

## Overview

The dashboard is the read surface of the Notion Ops Dashboard. It renders four widget groups
on the index route (`/`) from a **local D1 mirror** of the user's Notion workspace. This
document describes each capability, the exact data it shows, and the source table/columns it
reads.

## The read-model approach (read the mirror, never Notion)

The single most important architectural property of this phase:

> **The dashboard reads the D1 snapshot tables. It never calls the Notion API at request
> time.**

```
Notion (source of truth)
      │
      │  Phase 3 cron sync (~1 min cadence)
      ▼
D1 snapshot tables  ◄──── read-only ──── Dashboard loaders (this phase)
(task_snapshot, timer_snapshot,
 routine_snapshot, txn_snapshot,
 goals_snapshot)
```

Why this matters:

- **Speed & reliability.** Reads hit D1 co-located with the Worker — single-digit
  milliseconds, no Notion rate limits, no outbound API latency, no Notion outage on the
  request path.
- **Simplicity.** Loaders are plain SQL. No token handling, pagination, or Notion schema
  quirks in the request path — all of that lives in Phase 3.
- **Bounded staleness, not stale.** The mirror lags Notion by at most one cron cycle
  (~1 min). Combined with loader auto-invalidation, an edit made in Notion surfaces on the
  dashboard within about a minute — which is the phase's exit criterion.

Practical consequence: **all D1 access happens in route loaders on the Worker** (server-side),
because the `DB` binding only exists in the Worker runtime (`context.cloudflare.env.DB`).
Client components receive already-queried data as loader output and render it. The only
client-side dynamic behavior is (a) the live elapsed-seconds ticker and (b) the periodic
loader invalidation.

## Capability 1 — Server-side D1 loaders (no client Notion calls)

- Each route defines a `loader` that runs on the Worker. It pulls `env = context.cloudflare.env`
  and issues prepared statements against `env.DB`.
- Loaders return a plain serializable object. TanStack Start serializes it into the SSR
  payload and hands it to components via `Route.useLoaderData()`.
- **No Notion SDK import** appears anywhere in the dashboard route code. If a widget needs a
  value, it must already be in a snapshot table; if it isn't, that's a Phase 3 gap, not a
  Phase 5 workaround.
- Loaders are the *only* place D1 is touched. Components are pure render functions of loader
  data + local clock state.

## Capability 2 — The four widgets

### Widget A — Now strip (current activity)

A single horizontal strip across the top showing what is happening *right now*.

| Field shown | Meaning | Source |
| --- | --- | --- |
| Active routine name | The routine block currently active | `routine_snapshot` where `active_now = 1` (LIMIT 1) |
| Running task title | The task currently being worked | `task_snapshot` joined to the running timer, or the timer's own task label |
| Running timer + **live elapsed** | Seconds since the timer started, ticking every second | `timer_snapshot` where `status = 'Running'` → `start_time`; elapsed computed client-side |

- If there is no active routine, the strip shows a calm "No active routine" state.
- If no timer is running, it shows "No timer running" and the elapsed counter is hidden.
- The elapsed value is **not** re-fetched every second. The loader supplies `start_time`
  once; the client computes `now - start_time` each tick (see Capability 3).

### Widget B — Today

Today's workload and time investment.

| Field shown | Meaning | Source |
| --- | --- | --- |
| Tasks due today | List of tasks whose due date is today | `task_snapshot` where `due_date` is today (local TZ) and not done |
| Completed count today | How many tasks were completed today | `task_snapshot` where `status = 'Done'` (or completed flag) and completed today |
| Total tracked time today | Sum of timer durations that fall on today | `timer_snapshot` — sum of seconds for today's timers, including the running one |

- "Today" is computed in a **fixed dashboard timezone** (see implementation pitfalls), not
  UTC and not the viewer's browser TZ, so "today" is stable and matches the operator's day.
- Total tracked time includes the currently running timer's elapsed portion so the number
  feels live (the running timer's contribution can be topped up client-side).

### Widget C — Trends (charts)

Two Chart.js visualizations of tracked time.

| Chart | Shows | Source |
| --- | --- | --- |
| **Bar chart** | Tracked time per day over the last 7 or 30 days | `timer_snapshot` grouped by day |
| **Donut chart** | Share of tracked time by Category | `timer_snapshot` grouped by `category` |

- A 7/30 toggle switches the bar chart window.
- Both charts render through a **client-only** Chart.js component (dynamic import) so Chart.js
  never executes during SSR (see Capability 5).
- Empty windows render an empty-state message rather than a broken/blank canvas.

### Widget D — Finance

This month's money picture.

| Field shown | Meaning | Source |
| --- | --- | --- |
| Income this month | Sum of positive/income transactions in the current month | `txn_snapshot` grouped by month, `type = 'Income'` |
| Expense this month | Sum of expense transactions in the current month | `txn_snapshot` grouped by month, `type = 'Expense'` |
| Expense Goal | The budget/goal for the month to compare against | `goals_snapshot` (joined by month/period) |
| Spend by Category | Donut of expenses grouped by category | `txn_snapshot` where `type = 'Expense'`, grouped by `category` |
| Recent transactions | Latest N transactions with date, category, amount | `txn_snapshot` ordered by date desc, LIMIT N |

- The month-level income/expense figures are **joined against `goals_snapshot`** so the UI
  can show expense-vs-goal (e.g. a progress bar: expense / expense goal).
- A donut visualizes spend distribution by category; the recent-transactions list gives the
  raw detail underneath.

## Capability 3 — Client-side live elapsed timer

- The loader returns the running timer's `start_time` (once). A React component uses
  `useEffect` + `setInterval(…, 1000)` to hold a `now` value in state and renders
  `formatDuration(now - start_time)` each second.
- This keeps the second-by-second animation **entirely client-side** — no network per tick,
  no server load, correct even between loader refreshes.
- The interval is cleared on unmount and reset whenever `start_time` changes (a new timer
  starts).

## Capability 4 — Auto-refresh without websockets

- The route stays live by **re-running its loader on an interval of 30–60s**, using either:
  - `router.invalidate()` on a `setInterval`, or
  - TanStack Query with `refetchInterval`.
- No websockets, no SSE. This is intentional: the upstream data only changes at cron cadence
  (~1 min), so polling at ≤ 60s is more than fast enough and far simpler to operate on a
  Worker.
- Combined visible latency for a Notion edit = *cron cadence* + *invalidation interval* ≈ one
  minute, satisfying the exit criterion.

## Capability 5 — Charts (Chart.js, client-only)

- Chart.js is imported **only in the browser** via a dynamic import inside a client-gated
  component, because Chart.js touches DOM/canvas APIs that don't exist during SSR.
- The dashboard renders a stable placeholder (matching chart height) on the server and swaps
  in the real canvas after hydration, preventing layout shift.
- Two chart types are used: **bar** (tracked time per day) and **donut/doughnut** (time by
  category, spend by category).
- Charts are theme-aware where practical (light/dark friendly colors).

## Capability 6 — Responsive, light/dark-friendly layout

- A clean CSS grid: Now strip full-width on top, then a responsive grid of Today / Trends /
  Finance cards that collapses to a single column on narrow screens.
- Uses CSS custom properties and `prefers-color-scheme` so the dashboard looks correct in
  both light and dark without a manual theme toggle.

## Out of scope (Phase 6)

- `/register` — push-notification device registration.
- `/test-push` — push test tooling.

These are noted here only to mark the boundary; they are **not** built in Phase 5.
