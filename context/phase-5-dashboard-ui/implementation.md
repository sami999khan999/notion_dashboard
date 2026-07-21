# Phase 5 — Dashboard UI + Charts · Implementation

This document contains the concrete implementation for the index dashboard route: the loader
with all four widgets' SQL, the React widget components, the client-side elapsed-seconds
ticker, the SSR-safe Chart.js integration, the auto-invalidation pattern, styling notes, route
structure, per-criterion verification, and pitfalls.

> **Runtime model.** TanStack Start SSR on a Cloudflare Worker. Loaders run on the Worker and
> read D1 via `context.cloudflare.env.DB`. Components render on the server and hydrate on the
> client. Timers tick client-side. Charts are client-only (dynamic import).

---

## 1. Assumed snapshot table columns

The SQL below assumes these columns (from Phase 2). Adjust names to match the actual schema if
they differ — the intent is what matters.

| Table | Columns used |
| --- | --- |
| `routine_snapshot` | `id`, `name`, `active_now` (0/1), `start_time`, `end_time` |
| `timer_snapshot` | `id`, `task_id`, `task_title`, `category`, `status` ('Running'/'Stopped'), `start_time` (unix seconds or ISO), `end_time`, `duration_seconds` |
| `task_snapshot` | `id`, `title`, `status`, `due_date` (ISO date), `completed_at` (ISO datetime), `category` |
| `txn_snapshot` | `id`, `date` (ISO date), `type` ('Income'/'Expense'), `category`, `amount` (number), `note` |
| `goals_snapshot` | `id`, `period` ('YYYY-MM'), `metric` ('Expense'), `target` (number) |

> **Time storage note.** The queries assume `start_time`/`date` are stored as ISO strings and
> use SQLite's `date()`/`datetime()` functions with an explicit timezone offset. If your
> schema stores unix epoch seconds instead, swap `date(col)` for
> `date(col, 'unixepoch', :tzOffset)`. Pick one convention in Phase 2 and stay consistent.

We use a **fixed dashboard timezone** so "today" is stable. Below, `:tzOffset` is a modifier
like `'+00:00'` or `'-05:00'`; keep it in one constant.

---

## 2. Index route loader (all four widgets)

`apps/worker/src/routes/index.tsx`

```ts
import { createFileRoute } from "@tanstack/react-router";

// Fixed dashboard timezone offset. Everything "today"/"this month" is computed against this
// so the day boundary is stable regardless of where the viewer's browser is.
const TZ = "-05:00"; // e.g. America/New_York (no DST handling; see pitfalls)

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const env = context.cloudflare.env;
    const db = env.DB;

    // ---- Now strip -------------------------------------------------------
    const now = await db
      .prepare("SELECT * FROM routine_snapshot WHERE active_now = 1 LIMIT 1")
      .first();

    const running = await db
      .prepare("SELECT * FROM timer_snapshot WHERE status = 'Running' LIMIT 1")
      .first();

    // ---- Today -----------------------------------------------------------
    // Tasks due today (local day), not yet done.
    const dueToday = await db
      .prepare(
        `SELECT id, title, status, due_date, category
           FROM task_snapshot
          WHERE date(due_date, :tz) = date('now', :tz)
            AND status != 'Done'
          ORDER BY title`
      )
      .bind(TZ)
      .all();

    // Completed count today.
    const completedToday = await db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM task_snapshot
          WHERE status = 'Done'
            AND completed_at IS NOT NULL
            AND date(completed_at, :tz) = date('now', :tz)`
      )
      .bind(TZ)
      .first<{ n: number }>();

    // Total tracked seconds today (finished timers). The running timer's live portion is
    // added client-side so the number keeps moving between refreshes.
    const trackedToday = await db
      .prepare(
        `SELECT COALESCE(SUM(duration_seconds), 0) AS secs
           FROM timer_snapshot
          WHERE status = 'Stopped'
            AND date(start_time, :tz) = date('now', :tz)`
      )
      .bind(TZ)
      .first<{ secs: number }>();

    // ---- Trends ----------------------------------------------------------
    // Tracked time per day for the last 30 days (client slices to 7 as needed).
    const perDay = await db
      .prepare(
        `SELECT date(start_time, :tz) AS day,
                COALESCE(SUM(duration_seconds), 0) AS secs
           FROM timer_snapshot
          WHERE status = 'Stopped'
            AND date(start_time, :tz) >= date('now', :tz, '-29 days')
          GROUP BY day
          ORDER BY day`
      )
      .bind(TZ)
      .all();

    // Time by category over the last 30 days.
    const byCategory = await db
      .prepare(
        `SELECT COALESCE(category, 'Uncategorized') AS category,
                COALESCE(SUM(duration_seconds), 0) AS secs
           FROM timer_snapshot
          WHERE status = 'Stopped'
            AND date(start_time, :tz) >= date('now', :tz, '-29 days')
          GROUP BY category
          ORDER BY secs DESC`
      )
      .bind(TZ)
      .all();

    // ---- Finance ---------------------------------------------------------
    const month = "%Y-%m"; // strftime pattern for current-month grouping

    // Current-month income vs expense (one row of totals).
    const monthTotals = await db
      .prepare(
        `SELECT
            COALESCE(SUM(CASE WHEN type = 'Income'  THEN amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN type = 'Expense' THEN amount END), 0) AS expense
           FROM txn_snapshot
          WHERE strftime(:m, date, :tz) = strftime(:m, 'now', :tz)`
      )
      .bind(month, TZ)
      .first<{ income: number; expense: number }>();

    // Expense goal for the current month (join by period).
    const expenseGoal = await db
      .prepare(
        `SELECT target
           FROM goals_snapshot
          WHERE metric = 'Expense'
            AND period = strftime(:m, 'now', :tz)
          LIMIT 1`
      )
      .bind(month, TZ)
      .first<{ target: number }>();

    // Spend by category this month (expenses only).
    const spendByCategory = await db
      .prepare(
        `SELECT COALESCE(category, 'Uncategorized') AS category,
                COALESCE(SUM(amount), 0) AS amount
           FROM txn_snapshot
          WHERE type = 'Expense'
            AND strftime(:m, date, :tz) = strftime(:m, 'now', :tz)
          GROUP BY category
          ORDER BY amount DESC`
      )
      .bind(month, TZ)
      .all();

    // Recent transactions.
    const recentTxns = await db
      .prepare(
        `SELECT id, date, type, category, amount, note
           FROM txn_snapshot
          ORDER BY date DESC, id DESC
          LIMIT 10`
      )
      .all();

    return {
      now,
      running,
      today: {
        dueToday: dueToday.results ?? [],
        completedToday: completedToday?.n ?? 0,
        trackedTodaySecs: trackedToday?.secs ?? 0,
      },
      trends: {
        perDay: perDay.results ?? [],
        byCategory: byCategory.results ?? [],
      },
      finance: {
        income: monthTotals?.income ?? 0,
        expense: monthTotals?.expense ?? 0,
        expenseGoal: expenseGoal?.target ?? null,
        spendByCategory: spendByCategory.results ?? [],
        recentTxns: recentTxns.results ?? [],
      },
    };
  },
  component: DashboardPage,
});
```

> **Named vs positional binds.** D1 supports `?` positional binds; some setups prefer them
> over `:name`. If your D1 client doesn't support named parameters, replace `:tz`/`:m` with
> `?` and pass values positionally in order. The SQL semantics are identical.

---

## 3. Page shell + widget components

`apps/worker/src/routes/index.tsx` (continued — components)

```tsx
function DashboardPage() {
  const data = Route.useLoaderData();
  useAutoInvalidate(45_000); // see §5

  return (
    <div className="dash">
      <NowStrip now={data.now} running={data.running} />
      <div className="dash-grid">
        <TodayCard today={data.today} runningStart={data.running?.start_time} />
        <TrendsCard trends={data.trends} />
        <FinanceCard finance={data.finance} />
      </div>
    </div>
  );
}
```

### 3.1 Now strip (with live elapsed)

```tsx
function NowStrip({ now, running }: { now: any; running: any }) {
  return (
    <section className="now-strip card">
      <div className="now-item">
        <span className="label">Routine</span>
        <span className="value">{now?.name ?? "No active routine"}</span>
      </div>
      <div className="now-item">
        <span className="label">Task</span>
        <span className="value">{running?.task_title ?? "No timer running"}</span>
      </div>
      <div className="now-item">
        <span className="label">Elapsed</span>
        <span className="value mono">
          {running ? <LiveElapsed startTime={running.start_time} /> : "—"}
        </span>
      </div>
    </section>
  );
}
```

### 3.2 Today card

```tsx
function TodayCard({ today, runningStart }: { today: any; runningStart?: string }) {
  // Top up total with the running timer's live seconds.
  const liveExtra = useLiveSeconds(runningStart);
  const totalSecs = today.trackedTodaySecs + (runningStart ? liveExtra : 0);

  return (
    <section className="card">
      <h2>Today</h2>
      <div className="stat-row">
        <Stat label="Due today" value={today.dueToday.length} />
        <Stat label="Completed" value={today.completedToday} />
        <Stat label="Tracked" value={formatDuration(totalSecs)} />
      </div>
      <ul className="task-list">
        {today.dueToday.length === 0 && <li className="empty">Nothing due today.</li>}
        {today.dueToday.map((t: any) => (
          <li key={t.id}>
            <span className="dot" /> {t.title}
            {t.category && <span className="tag">{t.category}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
```

### 3.3 Trends card

```tsx
import { useState } from "react";

function TrendsCard({ trends }: { trends: any }) {
  const [window, setWindow] = useState<7 | 30>(7);
  const days = trends.perDay.slice(-window);

  const barData = {
    labels: days.map((d: any) => d.day.slice(5)), // MM-DD
    datasets: [
      {
        label: "Tracked (h)",
        data: days.map((d: any) => +(d.secs / 3600).toFixed(2)),
      },
    ],
  };

  const donutData = {
    labels: trends.byCategory.map((c: any) => c.category),
    datasets: [{ data: trends.byCategory.map((c: any) => +(c.secs / 3600).toFixed(2)) }],
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Trends</h2>
        <div className="toggle">
          <button aria-pressed={window === 7} onClick={() => setWindow(7)}>7d</button>
          <button aria-pressed={window === 30} onClick={() => setWindow(30)}>30d</button>
        </div>
      </div>
      <ClientChart type="bar" data={barData} />
      <h3>By category</h3>
      <ClientChart type="doughnut" data={donutData} />
    </section>
  );
}
```

### 3.4 Finance card

```tsx
function FinanceCard({ finance }: { finance: any }) {
  const { income, expense, expenseGoal, spendByCategory, recentTxns } = finance;
  const pctOfGoal = expenseGoal ? Math.min(100, (expense / expenseGoal) * 100) : null;

  const donutData = {
    labels: spendByCategory.map((c: any) => c.category),
    datasets: [{ data: spendByCategory.map((c: any) => c.amount) }],
  };

  return (
    <section className="card">
      <h2>Finance — this month</h2>
      <div className="stat-row">
        <Stat label="Income" value={formatMoney(income)} />
        <Stat label="Expense" value={formatMoney(expense)} />
        <Stat label="Goal" value={expenseGoal != null ? formatMoney(expenseGoal) : "—"} />
      </div>

      {pctOfGoal != null && (
        <div className="progress" aria-label="Expense vs goal">
          <div
            className={"progress-fill" + (pctOfGoal >= 100 ? " over" : "")}
            style={{ width: `${pctOfGoal}%` }}
          />
          <span className="progress-text">{pctOfGoal.toFixed(0)}% of goal</span>
        </div>
      )}

      <h3>Spend by category</h3>
      <ClientChart type="doughnut" data={donutData} />

      <h3>Recent</h3>
      <table className="txn-table">
        <tbody>
          {recentTxns.map((t: any) => (
            <tr key={t.id}>
              <td>{t.date.slice(5)}</td>
              <td>{t.category ?? "—"}</td>
              <td className={t.type === "Income" ? "pos" : "neg"}>
                {t.type === "Income" ? "+" : "−"}
                {formatMoney(t.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

---

## 4. Client-side elapsed-seconds ticker

`start_time` comes from the loader once; the browser computes elapsed each second. Two shapes:
a hook that returns raw seconds (used to top up "tracked today") and a component that renders a
formatted duration.

`apps/worker/src/lib/useLiveSeconds.ts`

```ts
import { useEffect, useState } from "react";

/** Parse start_time (ISO string or unix seconds) to epoch ms. */
function toMs(startTime: string | number): number {
  if (typeof startTime === "number") return startTime * 1000;
  const n = Number(startTime);
  if (!Number.isNaN(n) && String(n) === startTime) return n * 1000; // numeric string
  return new Date(startTime).getTime(); // ISO
}

/** Returns whole seconds elapsed since startTime, updating every second. */
export function useLiveSeconds(startTime?: string | number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (startTime == null) return;
    setNowMs(Date.now()); // resync immediately when start changes
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startTime]);

  if (startTime == null) return 0;
  return Math.max(0, Math.floor((nowMs - toMs(startTime)) / 1000));
}
```

`apps/worker/src/components/LiveElapsed.tsx`

```tsx
import { useLiveSeconds } from "../lib/useLiveSeconds";
import { formatDuration } from "../lib/format";

export function LiveElapsed({ startTime }: { startTime: string | number }) {
  const secs = useLiveSeconds(startTime);
  return <>{formatDuration(secs)}</>;
}
```

> **SSR/hydration note.** `useState(() => Date.now())` produces a slightly different value on
> server vs client. That's fine for a ticking clock, but to avoid a hydration warning either
> render a stable placeholder until mounted, or accept that the counter self-corrects on the
> first tick. Simplest robust approach: gate with a `mounted` flag and render `"—"` until the
> first client render.

---

## 5. Auto-invalidation (no websockets)

Two supported patterns. Pick one; the interval must be ≤ 60s.

### 5.1 Plain router.invalidate on an interval (recommended, no extra deps)

`apps/worker/src/lib/useAutoInvalidate.ts`

```ts
import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Re-run the current route's loaders every `ms` (default 45s). Pauses when tab hidden. */
export function useAutoInvalidate(ms = 45_000) {
  const router = useRouter();
  useEffect(() => {
    let id: ReturnType<typeof setInterval>;
    const start = () => {
      stop();
      id = setInterval(() => {
        if (document.visibilityState === "visible") router.invalidate();
      }, ms);
    };
    const stop = () => id && clearInterval(id);
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [ms, router]);
}
```

Pausing when the tab is hidden avoids pointless Worker/D1 hits for a backgrounded dashboard.

### 5.2 TanStack Query alternative

If the project already uses TanStack Query, mirror the loader data into a query with
`refetchInterval` instead:

```ts
const { data } = useQuery({
  queryKey: ["dashboard"],
  queryFn: () => fetch("/api/dashboard").then((r) => r.json()),
  refetchInterval: 45_000,
  refetchIntervalInBackground: false,
});
```

This requires a server route that returns the same payload the loader builds. For a pure
TanStack Start app, pattern 5.1 is simpler because the loader already exists.

---

## 6. Chart.js as a client-only component (SSR-safe)

Chart.js touches `canvas`/DOM APIs that don't exist during SSR on the Worker, so it must be
**dynamically imported in the browser only**. We render a fixed-height placeholder on the
server and swap in the canvas after mount.

`apps/worker/src/components/ClientChart.tsx`

```tsx
import { useEffect, useRef, useState } from "react";

type ChartType = "bar" | "doughnut";

export function ClientChart({ type, data }: { type: ChartType; data: any }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<any>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted || !canvasRef.current) return;
    let disposed = false;

    (async () => {
      // Dynamic import → Chart.js only loads in the browser, never during SSR.
      const { Chart, registerables } = await import("chart.js");
      Chart.register(...registerables);
      if (disposed || !canvasRef.current) return;

      chartRef.current?.destroy();
      chartRef.current = new Chart(canvasRef.current, {
        type,
        data,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "bottom" } },
        },
      });
    })();

    return () => {
      disposed = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [mounted, type, data]);

  // Reserve height on both server and client to avoid layout shift on hydration.
  return (
    <div className="chart-box" style={{ height: 220 }}>
      {mounted ? (
        <canvas ref={canvasRef} />
      ) : (
        <div className="chart-skeleton" aria-hidden />
      )}
    </div>
  );
}
```

Key points:

- `await import("chart.js")` inside `useEffect` guarantees the module never executes on the
  server.
- The chart is destroyed and rebuilt when `data` changes (e.g. after a loader refresh or a
  7/30 toggle) and always destroyed on unmount to avoid canvas leaks.
- Fixed container height on both server and client prevents cumulative layout shift.

---

## 7. Formatting helpers

`apps/worker/src/lib/format.ts`

```ts
/** Seconds → "1h 05m 09s" / "5m 09s" / "9s". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** Number → currency. Keep the locale/currency in one place. */
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export function formatMoney(n: number): string {
  return money.format(n ?? 0);
}
```

---

## 8. Styling notes

- **Layout.** Now strip is full-width; below it a responsive grid:

  ```css
  .dash { display: flex; flex-direction: column; gap: 1rem; padding: 1rem; }
  .dash-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 1rem;
  }
  .now-strip { display: flex; gap: 2rem; flex-wrap: wrap; }
  ```

  On narrow screens `auto-fit` collapses cards to a single column automatically.

- **Light/dark friendly.** Drive colors from CSS custom properties and flip them with
  `prefers-color-scheme`:

  ```css
  :root {
    --bg: #f7f7f8; --card: #ffffff; --text: #16181d; --muted: #6b7280;
    --border: #e5e7eb; --pos: #15803d; --neg: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0f14; --card: #161a22; --text: #e6e8ee; --muted: #9aa3b2;
      --border: #232a36; --pos: #4ade80; --neg: #f87171;
    }
  }
  body { background: var(--bg); color: var(--text); }
  .card { background: var(--card); border: 1px solid var(--border);
          border-radius: 12px; padding: 1rem; }
  .mono { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
  ```

- Use `tabular-nums` for the live elapsed counter so digits don't jitter each second.
- Chart colors should read in both themes; pass an explicit accessible palette to Chart.js
  rather than relying on defaults.

---

## 9. Route structure

```
apps/worker/src/routes/
  __root.tsx        # root layout: <html>, styles, providers
  index.tsx         # THIS PHASE — the dashboard (all four widgets)
  register.tsx      # PHASE 6 — push registration (NOT built here)
  test-push.tsx     # PHASE 6 — push test tooling (NOT built here)
```

- Phase 5 ships **only** `index.tsx` (plus shared components/lib it imports).
- `/register` and `/test-push` are **Phase 6**. They're listed to mark the boundary; the file
  tree already reserves their spot so Phase 6 can drop them in without touching the dashboard.
- All D1 access lives in the `index` route loader. Shared components (`LiveElapsed`,
  `ClientChart`, `Stat`) and lib helpers (`useLiveSeconds`, `useAutoInvalidate`, `format`) are
  pure client/render utilities with no D1 dependency.

---

## 10. Verification (per exit criterion)

| Exit criterion | How to verify |
| --- | --- |
| All four widgets render from D1 | Load `/`. Confirm Now strip, Today, Trends, Finance each show data. Temporarily change a snapshot row via `wrangler d1 execute` and confirm the value changes after the next refresh — proving it reads D1, not hardcoded. |
| Live elapsed ticks client-side | With a running timer (`status='Running'`), watch the Now strip: the elapsed counter increments every second. Open DevTools Network — confirm **no** request fires per tick (proves it's computed client-side, not fetched). |
| Loader auto-refreshes ≤ 60s | In DevTools Network, observe the route loader / data request re-firing every 45s (or whatever interval is set). Confirm the interval is ≤ 60s and pauses when the tab is hidden. |
| Notion edit within one cron cycle | Edit a value in Notion (e.g. mark a task done). Wait one cron cycle (~1 min) for Phase 3 to mirror it into D1. Confirm the dashboard reflects the change automatically (via the auto-invalidation) without a manual reload. Total observed latency ≈ cron cadence + invalidation interval ≈ 1 min. |

Additional sanity checks:

- View the page with JS disabled → SSR HTML still shows all widget data (charts show
  placeholders). Confirms server-side rendering works and charts fail safe.
- Toggle 7d/30d in Trends → bar chart re-renders without a full reload.
- Empty states: with no active routine / no running timer / no txns, widgets show calm
  empty-state text, not errors.

---

## 11. Pitfalls

1. **Chart.js must be client-only.** Importing `chart.js` at module top level will execute
   during SSR on the Worker where `window`/`document`/`canvas` don't exist → the render
   crashes. Always `await import("chart.js")` inside a `useEffect`/mount-gated component, and
   render a placeholder on the server (see §6).

2. **The loader runs on the Worker — D1 binding is server-only.** `context.cloudflare.env.DB`
   exists only in the Worker runtime. Never try to query D1 from a client component or a
   browser-side effect; there's no binding there. All SQL lives in the loader. If a component
   needs data, it must come through loader output.

3. **Timezone for "today".** `date('now')` in SQLite is UTC. If you compare against UTC, the
   day boundary will be wrong for the operator's local day (tasks "due today" flip at the
   wrong hour). Use a fixed `:tzOffset` modifier consistently across *every* today/month
   query, and keep it in one constant. Note the simple fixed-offset approach doesn't handle
   DST; if that matters, compute the day boundary in the loader (JS with a proper TZ) and pass
   explicit `>= start AND < end` timestamps instead of relying on `date(..., :tz)`.

4. **Invalidation interval vs cron cadence.** No point polling faster than the data changes.
   Cron runs ~1 min; an invalidation interval of 30–60s keeps visible latency near one cron
   cycle without hammering D1. Going much faster (e.g. every 5s) just multiplies Worker/D1
   reads for no fresher data. Also pause polling when the tab is hidden.

5. **Number/seconds formatting.** Store durations as **seconds** (integers) and money as
   plain numbers; format only at the edge (`formatDuration`, `formatMoney`). Convert seconds →
   hours for charts (`secs/3600`) and round for display. Use `tabular-nums` on the live
   counter so it doesn't shift width each second. Don't do float math on money in SQL beyond
   summation; keep a single currency/locale in `formatMoney`.

6. **Hydration mismatch on the live clock.** `Date.now()` differs between server render and
   client hydration. Gate the ticker with a `mounted` flag (render `"—"` until mounted) or
   accept the self-correcting first tick; otherwise React logs a hydration warning.

7. **Chart lifecycle leaks.** A new `Chart(...)` on every data change without
   `chart.destroy()` leaks canvases and stacks tooltips. Always destroy the previous instance
   before creating a new one and on unmount (see §6).

8. **Running timer double-counting.** "Tracked today" sums `status='Stopped'` timers only, then
   tops up the running timer's live seconds client-side. If you also summed the running timer's
   (incomplete) `duration_seconds` in SQL you'd either double-count or show a stale value —
   keep the running portion client-side only.
