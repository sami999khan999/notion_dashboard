# Phase 5 — Dashboard UI + Charts · Goals

## Objective

Build the **read-only operations dashboard** — the human-facing surface of the Notion Ops
Dashboard project. It is a TanStack Start (React) SSR application running on a Cloudflare
Worker. Every route loader reads the **D1 snapshot tables** (populated by the Phase 3 sync
engine) server-side through the Worker binding (`context.cloudflare.env.DB`), renders on the
server, hydrates on the client, and stays live by re-invalidating on a short interval — no
websockets.

The dashboard is a **read model**. It never calls the Notion API at request time. It reflects
whatever the Phase 3 cron sync last mirrored into D1. The user's source of truth stays in
Notion; the dashboard is a fast, always-on window onto a local mirror of it.

Phase 5 delivers four widget groups on the index route (`/`):

| Widget | One-line purpose | Primary source table(s) |
| --- | --- | --- |
| **Now strip** | What is happening *right now* | `routine_snapshot`, `timer_snapshot`, `task_snapshot` |
| **Today** | Today's workload and time tracked | `task_snapshot`, `timer_snapshot` |
| **Trends** | Tracked time over 7/30 days and by category | `timer_snapshot` (Chart.js) |
| **Finance** | This month income vs expense vs goal, spend by category, recent txns | `txn_snapshot`, `goals_snapshot` (Chart.js) |

## Exit criteria

Phase 5 is **done** when all of the following hold:

1. **All four widget groups render from D1.** The Now strip, Today, Trends, and Finance
   widgets each display real data read server-side from the snapshot tables. No widget makes
   a client-side Notion call; no widget hardcodes sample data.
2. **The live elapsed timer ticks client-side.** When a timer row has `status='Running'`, the
   Now strip shows elapsed seconds that increment every second in the browser, computed from
   `start_time` — not re-fetched from the server each tick.
3. **The loader auto-refreshes at ≤ 60s.** Without any user interaction and without
   websockets, the route re-runs its loader on an interval of 30–60 seconds so newly synced
   data appears automatically.
4. **A Notion edit appears within one cron cycle (~1 min).** End-to-end: edit a value in
   Notion → Phase 3 cron mirrors it into D1 (≤ ~1 min) → the auto-invalidating loader picks
   it up → the widget updates. The visible latency is bounded by *cron cadence + invalidation
   interval*, which is on the order of one minute.

## Dependencies

- **Phase 2 — Schema / D1 tables.** The snapshot table shapes
  (`task_snapshot`, `timer_snapshot`, `routine_snapshot`, `txn_snapshot`, `goals_snapshot`)
  and their columns are defined there. This phase reads those columns directly.
- **Phase 3 — Sync engine.** The cron sync populates and refreshes the snapshot tables.
  Without it the dashboard renders empty; the "within one cron cycle" exit criterion is a
  property of Phase 3's cadence combined with this phase's invalidation interval.

The dashboard has **no dependency on the Notion API at runtime** — that is the whole point of
the read-model design. All Notion access is confined to Phase 3.

## Relationship to other phases

- **Parallelizable with Phase 4.** Phase 4 (whatever it owns — e.g. the write-back /
  command path) touches different code and does not gate this phase. Phase 5 only needs the
  D1 read model to exist, so once Phases 2 + 3 are in place, Phase 4 and Phase 5 can proceed
  concurrently.
- **Precedes Phase 6.** The `/register` and `/test-push` routes (push-notification
  registration and test tooling) belong to **Phase 6** and are explicitly **out of scope**
  here. Phase 5 ships only the index dashboard route. The route tree is structured so Phase 6
  can add those routes without touching the dashboard.

## Effort

**~1.5 days.** Roughly: half a day on the loader + SQL for all four widgets, half a day on
the React widget components + live ticker + auto-invalidation, and half a day on the Chart.js
client-only integration, responsive styling, and end-to-end verification against a live sync.

## Non-goals

- No write-back to Notion from the dashboard (that is not this phase's concern).
- No authentication / multi-user (single-operator dashboard for this project's scope).
- No push notifications or device registration (Phase 6).
- No websockets or server-sent events — polling via loader invalidation is deliberate and
  sufficient given the ~1 min cron cadence.
