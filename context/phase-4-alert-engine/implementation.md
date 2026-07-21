# Phase 4 — Alert Engine + Channels — Implementation

This document contains the concrete types, SQL, and code for the alert engine. All code lives under `apps/worker/src/alerts/`. Everything runs inside the Cloudflare Worker's `scheduled()` handler, after the Phase 3 upsert.

## Table of contents

1. [The `Alert` type and `Env`](#the-alert-type-and-env)
2. [Time zones and day boundaries](#time-zones-and-day-boundaries)
3. [The seven rule functions](#the-seven-rule-functions)
4. [The dispatcher](#the-dispatcher)
5. [`recordSent`, `sendEmail`, stub `pushFcm`](#channels-and-logging)
6. [A4 edge-trigger coordination with Phase 3](#a4-edge-trigger-coordination-with-phase-3)
7. [Threshold semantics](#threshold-semantics)
8. [Testing](#testing)
9. [Pitfalls](#pitfalls)

---

## The `Alert` type and `Env`

```ts
// apps/worker/src/alerts/types.ts

export type AlertRule = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7";
export type AlertChannel = "push" | "email";

export interface Alert {
  rule: AlertRule;
  /** Id of the entity the alert is about (timer/task/routine id, or a synthetic key). */
  entityId: string;
  /** Discriminator so one rule can fire at multiple tiers. Part of the dedupe key. */
  threshold: string;
  channel: AlertChannel;
  /** Push title / email subject. */
  title: string;
  /** Push body. */
  body: string;
  /** Email HTML body (only used when channel === "email"). */
  html: string;
  /** Deep link back into Notion; passed as push data. */
  notionUrl: string;
}

export interface Env {
  DB: D1Database;
  // Resend (email channel)
  RESEND_API_KEY: string;
  ALERT_FROM: string;   // e.g. "Ops Dashboard <alerts@yourdomain.com>"
  ALERT_TO: string;     // recipient
  // Local time zone used to compute "today" / "21:00" / "end-of-day" boundaries.
  ALERT_TZ: string;     // e.g. "Asia/Riyadh"
  // Focus target in seconds/day (A7); may later move to the goals table.
  FOCUS_TARGET_SECONDS?: string; // default handled in code, e.g. "14400" (4h)
}
```

---

## Time zones and day boundaries

**Rule: store everything in UTC.** Every `sent_at`, `start_time`, `deadline`, and transaction date in D1 is ISO 8601 UTC. That never changes.

But several rules reason about **human day boundaries** — "today", "the next 24 hours", "21:00", "end-of-day". Those are inherently local. If we naively used SQLite's `date('now')` (which is UTC), then late-evening local activity would be attributed to the wrong day and A5/A7 would fire at the wrong moment.

So we make the local zone **configurable via `env.ALERT_TZ`** and compute the local "today" once per run, then pass concrete UTC instants into the SQL. The cleanest approach on Workers is to compute boundary instants in JS (using `Intl`) and bind them as parameters, rather than relying on SQLite timezone modifiers.

```ts
// apps/worker/src/alerts/time.ts

/** Returns the local calendar date (YYYY-MM-DD) for `now` in the given IANA tz. */
export function localDateStr(now: Date, tz: string): string {
  // en-CA gives ISO-like YYYY-MM-DD formatting.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Returns the local wall-clock hour (0-23) for `now` in the given tz. */
export function localHour(now: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(now)
  );
}

/**
 * Given a local date string (YYYY-MM-DD) and tz, return the UTC ISO instant
 * for local midnight (00:00:00) of that day. Used as the lower bound of "today".
 */
export function localMidnightUtc(localDate: string, tz: string): string {
  // Find the offset for this tz at roughly this date by formatting a probe instant.
  const probe = new Date(`${localDate}T12:00:00Z`);
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  // tzName looks like "GMT+3" or "GMT+5:30"; parse into minutes.
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(tzName);
  const offH = m ? Number(m[1]) : 0;
  const offM = m ? Number(m[2] ?? "0") * Math.sign(offH || 1) : 0;
  const offsetMinutes = offH * 60 + (offH < 0 ? -Number(m?.[2] ?? 0) : offM);
  // local midnight in UTC = local 00:00 minus offset.
  const utc = new Date(`${localDate}T00:00:00Z`).getTime() - offsetMinutes * 60_000;
  return new Date(utc).toISOString();
}
```

> Keep the boundary math in one place. If DST correctness ever matters for the chosen zone, this is the single file to harden. For a fixed-offset zone (the common case for a single-user dashboard) the above is exact. The rules below take pre-computed boundary instants as inputs so the SQL stays simple.

A small helper computes the boundaries once per run and threads them through:

```ts
// apps/worker/src/alerts/context.ts
import { localDateStr, localHour, localMidnightUtc } from "./time";

export interface RunCtx {
  nowIso: string;         // current instant, UTC ISO
  localDate: string;      // e.g. "2026-07-21"
  localHour: number;      // 0-23
  todayStartUtc: string;  // UTC ISO of local midnight today
  todayEndUtc: string;    // UTC ISO of local midnight tomorrow (exclusive)
  next24hUtc: string;     // nowIso + 24h
  threeHoursAgoUtc: string;
  monthPrefix: string;    // "2026-07" for month grouping
}

export function makeCtx(env: Env, now = new Date()): RunCtx {
  const tz = env.ALERT_TZ;
  const localDate = localDateStr(now, tz);
  const todayStartUtc = localMidnightUtc(localDate, tz);
  const todayEndUtc = new Date(
    new Date(todayStartUtc).getTime() + 24 * 3600_000
  ).toISOString();
  return {
    nowIso: now.toISOString(),
    localDate,
    localHour: localHour(now, tz),
    todayStartUtc,
    todayEndUtc,
    next24hUtc: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    threeHoursAgoUtc: new Date(now.getTime() - 3 * 3600_000).toISOString(),
    monthPrefix: localDate.slice(0, 7),
  };
}
```

---

## The seven rule functions

All rules are pure reads. Each returns `Alert[]`. Schemas assumed from Phase 2 are noted inline.

### A1 — Orphan timer (push, high)

`timer_snapshot(id, status, start_time, end_time, notion_url, ...)`. Fire when running, started > 3h ago, no end time.

```ts
// apps/worker/src/alerts/rules/a1_orphanTimer.ts
import type { Alert, Env } from "../types";
import type { RunCtx } from "../context";

export async function ruleOrphanTimer(env: Env, ctx: RunCtx): Promise<Alert[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, start_time, notion_url
       FROM timer_snapshot
      WHERE status = 'Running'
        AND (end_time IS NULL OR end_time = '')
        AND start_time < ?`      -- older than 3h ago
  ).bind(ctx.threeHoursAgoUtc).all<{ id: string; start_time: string; notion_url: string }>();

  return (results ?? []).map((r) => ({
    rule: "A1",
    entityId: r.id,
    threshold: "1",
    channel: "push",
    title: "Orphan timer still running",
    body: `A timer has been running since ${r.start_time} (>3h). Did you forget to stop it?`,
    html: "",
    notionUrl: r.notion_url,
  }));
}
```

### A2 — Task overdue (push)

`task_snapshot(id, name, deadline, completed, archived, notion_url, ...)`. Deadline before local today, not completed, not archived.

```ts
// apps/worker/src/alerts/rules/a2_overdue.ts
import type { Alert, Env } from "../types";
import type { RunCtx } from "../context";

export async function ruleOverdue(env: Env, ctx: RunCtx): Promise<Alert[]> {
  // deadline strictly before start of local "today"
  const { results } = await env.DB.prepare(
    `SELECT id, name, deadline, notion_url
       FROM task_snapshot
      WHERE completed = 0
        AND archived = 0
        AND deadline IS NOT NULL
        AND deadline <> ''
        AND deadline < ?`
  ).bind(ctx.todayStartUtc).all<{ id: string; name: string; deadline: string; notion_url: string }>();

  return (results ?? []).map((r) => ({
    rule: "A2",
    entityId: r.id,
    threshold: "1",
    channel: "push",
    title: "Task overdue",
    body: `"${r.name}" was due ${r.deadline} and isn't done.`,
    html: "",
    notionUrl: r.notion_url,
  }));
}
```

> If `deadline` is stored as a date-only string (`YYYY-MM-DD`) rather than a full instant, compare against `ctx.localDate` instead: `deadline < ?` bound to `ctx.localDate`. Pick one representation in Phase 2 and be consistent. The examples here assume full UTC instants; date-only variants are noted per rule.

### A3 — Deadline soon (push)

Deadline within the next 24h and not completed.

```ts
// apps/worker/src/alerts/rules/a3_deadlineSoon.ts
import type { Alert, Env } from "../types";
import type { RunCtx } from "../context";

export async function ruleDeadlineSoon(env: Env, ctx: RunCtx): Promise<Alert[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, deadline, notion_url
       FROM task_snapshot
      WHERE completed = 0
        AND deadline IS NOT NULL
        AND deadline <> ''
        AND deadline >= ?      -- from now
        AND deadline <  ?`     -- to now + 24h
  ).bind(ctx.nowIso, ctx.next24hUtc)
   .all<{ id: string; name: string; deadline: string; notion_url: string }>();

  return (results ?? []).map((r) => ({
    rule: "A3",
    entityId: r.id,
    threshold: "1",
    channel: "push",
    title: "Deadline soon",
    body: `"${r.name}" is due within 24h (${r.deadline}).`,
    html: "",
    notionUrl: r.notion_url,
  }));
}
```

### A4 — Routine block starting (push, edge-triggered)

`routine_snapshot(id, name, active_now, prev_active_now, today, done, notion_url, ...)`. Fire on `prev_active_now = 0 AND active_now = 1`. See the [coordination section](#a4-edge-trigger-coordination-with-phase-3) for how `prev_active_now` gets populated.

```ts
// apps/worker/src/alerts/rules/a4_routineStart.ts
import type { Alert, Env } from "../types";
import type { RunCtx } from "../context";

export async function ruleRoutineStart(env: Env, ctx: RunCtx): Promise<Alert[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, notion_url
       FROM routine_snapshot
      WHERE active_now = 1
        AND (prev_active_now IS NULL OR prev_active_now = 0)`
  ).bind().all<{ id: string; name: string; notion_url: string }>();

  return (results ?? []).map((r) => ({
    rule: "A4",
    entityId: r.id,
    // Include the local date so a block that recurs daily re-arms each day.
    threshold: ctx.localDate,
    channel: "push",
    title: "Routine block starting",
    body: `"${r.name}" is starting now.`,
    html: "",
    notionUrl: r.notion_url,
  }));
}
```

> Two layers protect against re-fire: the SQL edge condition (`prev = 0, now = 1`) and the dedupe key. The edge condition means we only emit on the rising tick; the dedupe key (`A4`, routine id, local date) guarantees at-most-once even if two cron ticks somehow both observe the edge.

### A5 — Routine missed (email digest)

At end-of-day, routines with `today = 1 AND done = 0`. "End-of-day" is gated in JS on `ctx.localHour`; the SQL just selects the missed routines. Emitted as a **single digest email** (one `Alert` covering all misses) rather than one per routine.

```ts
// apps/worker/src/alerts/rules/a5_routineMissed.ts
import type { Alert, Env } from "../types";
import type { RunCtx } from "../context";

const END_OF_DAY_HOUR = 23; // local hour at/after which we consider the day "done"

export async function ruleRoutineMissed(env: Env, ctx: RunCtx): Promise<Alert[]> {
  if (ctx.localHour < END_OF_DAY_HOUR) return []; // only near end-of-day

  const { results } = await env.DB.prepare(
    `SELECT id, name, notion_url
       FROM routine_snapshot
      WHERE today = 1
        AND done  = 0
      ORDER BY name`
  ).bind().all<{ id: string; name: string; notion_url: string }>();

  const missed = results ?? [];
  if (missed.length === 0) return [];

  const items = missed.map((r) => `<li>${escapeHtml(r.name)}</li>`).join("");
  const html =
    `<h2>Routines missed on ${ctx.localDate}</h2>` +
    `<p>You planned these routines today but didn't complete them:</p>` +
    `<ul>${items}</ul>`;

  return [{
    rule: "A5",
    // One digest per day → entityId is the date, threshold is the date too.
    entityId: `digest-${ctx.localDate}`,
    threshold: ctx.localDate,
    channel: "email",
    title: `Routines missed on ${ctx.localDate}`,
    body: `${missed.length} routine(s) missed today.`,
    html,
    notionUrl: "",
  }];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
```

### A6 — Budget threshold (push + email, two tiers)

`txn_snapshot(id, type, amount, occurred_at, ...)` summed for the current month; `goals(key, amount)` holds the Expense Goal. Emits an independent candidate per tier (`"80"`, `"100"`) and per channel.

```ts
// apps/worker/src/alerts/rules/a6_budget.ts
import type { Alert, Env } from "../types";
import type { RunCtx } from "../context";

export async function ruleBudget(env: Env, ctx: RunCtx): Promise<Alert[]> {
  // Current-month expense sum. occurred_at is UTC ISO; group by local month prefix.
  // If occurred_at is a full instant, filter on the local month window instead of substr.
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS spent
       FROM txn_snapshot
      WHERE type = 'Expense'
        AND occurred_at >= ?      -- start of local month
        AND occurred_at <  ?`     -- start of next local month
  ).bind(monthStartUtc(ctx), monthEndUtc(ctx)).first<{ spent: number }>();

  const goalRow = await env.DB.prepare(
    `SELECT amount FROM goals WHERE key = 'Expense Goal' LIMIT 1`
  ).first<{ amount: number }>();

  const spent = row?.spent ?? 0;
  const goal = goalRow?.amount ?? 0;
  if (goal <= 0) return []; // no goal configured → nothing to compare

  const pct = (spent / goal) * 100;
  const alerts: Alert[] = [];

  const tiers: Array<{ threshold: "80" | "100"; at: number }> = [
    { threshold: "80", at: 80 },
    { threshold: "100", at: 100 },
  ];

  for (const t of tiers) {
    if (pct >= t.at) {
      // Entity id encodes the month so each month re-arms independently.
      const entityId = `expense-${ctx.monthPrefix}`;
      const title = `Budget ${t.threshold}% reached`;
      const body =
        `Expenses this month: ${spent.toFixed(2)} / ${goal.toFixed(2)} ` +
        `(${pct.toFixed(0)}%).`;
      const html = `<h2>${title}</h2><p>${body}</p>`;
      // Fire on BOTH channels; dedupe key differs by channel via threshold suffix.
      alerts.push({
        rule: "A6", entityId, threshold: `${t.threshold}`, channel: "push",
        title, body, html, notionUrl: "",
      });
      alerts.push({
        rule: "A6", entityId, threshold: `${t.threshold}-email`, channel: "email",
        title, body, html, notionUrl: "",
      });
    }
  }
  return alerts;
}

function monthStartUtc(ctx: RunCtx): string {
  // ctx.monthPrefix is "YYYY-MM"; local first-of-month midnight → UTC.
  // Reuse localMidnightUtc on the first day of the month.
  return new Date(`${ctx.monthPrefix}-01T00:00:00Z`).toISOString();
}
function monthEndUtc(ctx: RunCtx): string {
  const [y, m] = ctx.monthPrefix.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const mm = String(nextM).padStart(2, "0");
  return new Date(`${nextY}-${mm}-01T00:00:00Z`).toISOString();
}
```

> **Two-tier + two-channel dedupe.** The `threshold` string carries both the tier and (for email) a `-email` suffix so that the composite key `(A6, entity, threshold)` is distinct for each of the four possible sends: push-80, email-80, push-100, email-100. Each fires at most once per month. If you prefer, a simpler alternative is a separate `channel` column in the dedupe key — but keeping the key at three columns (as the reference dispatcher does) means encoding the channel into `threshold`.
>
> For pure date-only `occurred_at` (`YYYY-MM-DD`), replace the window filter with `substr(occurred_at,1,7) = ?` bound to `ctx.monthPrefix`.

### A7 — Focus goal (push)

By 21:00 local, sum of tracked seconds today `< target`.

```ts
// apps/worker/src/alerts/rules/a7_focusGoal.ts
import type { Alert, Env } from "../types";
import type { RunCtx } from "../context";

const FOCUS_HOUR = 21; // local

export async function ruleFocusGoal(env: Env, ctx: RunCtx): Promise<Alert[]> {
  if (ctx.localHour < FOCUS_HOUR) return []; // only at/after 21:00 local

  const target = Number(env.FOCUS_TARGET_SECONDS ?? "14400"); // default 4h

  // Sum tracked seconds for timers that fall in today's local window.
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(tracked_seconds), 0) AS total
       FROM timer_snapshot
      WHERE start_time >= ?
        AND start_time <  ?`
  ).bind(ctx.todayStartUtc, ctx.todayEndUtc).first<{ total: number }>();

  const total = row?.total ?? 0;
  if (total >= target) return [];

  const shortfall = target - total;
  return [{
    rule: "A7",
    entityId: `focus-${ctx.localDate}`,
    threshold: ctx.localDate,
    channel: "push",
    title: "Focus goal at risk",
    body: `Only ${Math.round(total / 60)} min tracked today; ` +
          `${Math.round(shortfall / 60)} min short of target.`,
    html: "",
    notionUrl: "",
  }];
}
```

> If timers don't carry a `tracked_seconds` column, compute it as `SUM((julianday(COALESCE(end_time, ?)) - julianday(start_time)) * 86400)` binding `ctx.nowIso` for still-running timers — but prefer a materialized `tracked_seconds` from Phase 2 for clarity and to avoid counting orphan timers.

---

## The dispatcher

```ts
// apps/worker/src/alerts/index.ts
import type { Alert, Env } from "./types";
import { makeCtx } from "./context";
import { ruleOrphanTimer } from "./rules/a1_orphanTimer";
import { ruleOverdue } from "./rules/a2_overdue";
import { ruleDeadlineSoon } from "./rules/a3_deadlineSoon";
import { ruleRoutineStart } from "./rules/a4_routineStart";
import { ruleRoutineMissed } from "./rules/a5_routineMissed";
import { ruleBudget } from "./rules/a6_budget";
import { ruleFocusGoal } from "./rules/a7_focusGoal";

export async function runAlertRules(env: Env): Promise<void> {
  const ctx = makeCtx(env);

  const candidates: Alert[] = [
    ...await ruleOrphanTimer(env, ctx),
    ...await ruleOverdue(env, ctx),
    ...await ruleDeadlineSoon(env, ctx),
    ...await ruleRoutineStart(env, ctx),
    ...await ruleRoutineMissed(env, ctx),
    ...await ruleBudget(env, ctx),
    ...await ruleFocusGoal(env, ctx),
  ];

  for (const a of candidates) {
    const seen = await env.DB.prepare(
      "SELECT 1 FROM alerts_sent WHERE rule = ? AND entity_id = ? AND threshold = ?"
    ).bind(a.rule, a.entityId, a.threshold).first();
    if (seen) continue;

    try {
      if (a.channel === "push") {
        await pushFcm(env, a.title, a.body, { url: a.notionUrl }, a.rule, a.entityId);
      } else if (a.channel === "email") {
        await sendEmail(env, a.title, a.html);
        await logEmail(env, a); // email path logs explicitly (pushFcm logs itself)
      }
      await recordSent(env, a);
    } catch (err) {
      // Do NOT record dedupe on failure, so the next tick retries.
      await env.DB.prepare(
        `INSERT INTO alert_log (rule, entity_id, channel, message, status, sent_at)
         VALUES (?, ?, ?, ?, 'error', datetime('now'))`
      ).bind(a.rule, a.entityId, a.channel, String(err)).run();
    }
  }
}
```

The scheduled handler wires it in after the upsert:

```ts
// apps/worker/src/index.ts (excerpt)
export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await syncNotionToD1(env);   // Phase 2/3: pull + upsert (captures prev_active_now)
    await runAlertRules(env);    // Phase 4
  },
};
```

---

## Channels and logging

### `recordSent` — writes both `alerts_sent` and `alert_log`

`alerts_sent` has composite PK `(rule, entity_id, threshold)`. `alert_log` is an append-only audit table.

```ts
// apps/worker/src/alerts/record.ts
import type { Alert, Env } from "./types";

export async function recordSent(env: Env, a: Alert): Promise<void> {
  // Dedupe row (idempotent via composite PK). Use INSERT OR IGNORE for safety.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO alerts_sent (rule, entity_id, threshold, sent_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).bind(a.rule, a.entityId, a.threshold).run();
}
```

The push channel logs itself (so the stub is self-contained); the email path logs via `logEmail`:

```ts
export async function logEmail(env: Env, a: Alert): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO alert_log (rule, entity_id, channel, message, status, sent_at)
     VALUES (?, ?, 'email', ?, 'sent', datetime('now'))`
  ).bind(a.rule, a.entityId, a.title).run();
}
```

Reference DDL (from Phase 2, repeated for clarity):

```sql
CREATE TABLE IF NOT EXISTS alerts_sent (
  rule       TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  threshold  TEXT NOT NULL,
  sent_at    TEXT NOT NULL,       -- ISO 8601 UTC (datetime('now'))
  PRIMARY KEY (rule, entity_id, threshold)
);

CREATE TABLE IF NOT EXISTS alert_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule       TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  channel    TEXT NOT NULL,       -- 'push' | 'email'
  message    TEXT,
  status     TEXT NOT NULL,       -- 'sent' | 'error'
  sent_at    TEXT NOT NULL
);
```

### `sendEmail` — Resend HTTP API (no SMTP)

```ts
// apps/worker/src/alerts/email.ts
import type { Env } from "./types";

export async function sendEmail(env: Env, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.ALERT_FROM,
      to: env.ALERT_TO,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  }
}
```

### `pushFcm` — STUB for this phase

Writes to `alert_log` so push rules are verifiable without a phone. Phase 6 replaces the body with a real FCM HTTP v1 call.

```ts
// apps/worker/src/alerts/push.ts
import type { Env } from "./types";

export async function pushFcm(
  env: Env,
  title: string,
  body: string,
  data: Record<string, string>,
  rule: string,
  entityId: string
): Promise<void> {
  // STUB: no network call. Log as if delivered.
  await env.DB.prepare(
    `INSERT INTO alert_log (rule, entity_id, channel, message, status, sent_at)
     VALUES (?, ?, 'push', ?, 'sent', datetime('now'))`
  ).bind(rule, entityId, `${title} — ${body}`).run();

  // Phase 6 will instead POST to
  //   https://fcm.googleapis.com/v1/projects/<project>/messages:send
  // with an OAuth bearer token and { message: { token, notification, data } }.
}
```

---

## A4 edge-trigger coordination with Phase 3

A4 must fire on the `active_now` transition `false → true`, not on every tick where `active_now = 1`. To detect the *edge*, the rule needs both the **previous** and the **current** value of `active_now`.

**The problem:** Phase 3's upsert overwrites `routine_snapshot` with fresh Notion data. If A4 runs *after* the upsert (which it does — rules read the fresh snapshot), the old `active_now` is already gone.

**The coordination:** Phase 3 captures the previous `active_now` **before** overwriting it and stores it in a companion column `prev_active_now`. Concretely, the upsert reads the existing row's `active_now` into `prev_active_now`, then writes the new `active_now`:

```sql
-- Phase 3 upsert (excerpt) — carry the old active_now into prev_active_now.
INSERT INTO routine_snapshot (id, name, active_now, prev_active_now, today, done, notion_url)
VALUES (?, ?, ?, 0, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  prev_active_now = routine_snapshot.active_now,  -- OLD value, captured before overwrite
  active_now      = excluded.active_now,          -- NEW value from Notion
  name            = excluded.name,
  today           = excluded.today,
  done            = excluded.done,
  notion_url      = excluded.notion_url;
```

Key point: in SQLite's `ON CONFLICT DO UPDATE`, `routine_snapshot.active_now` on the right-hand side still refers to the **existing** (pre-update) row value, while `excluded.active_now` is the incoming value. So `prev_active_now = routine_snapshot.active_now` reliably captures the old state in the same statement. A4 then reads `prev_active_now = 0 AND active_now = 1`.

**Ordering contract:** `syncNotionToD1` (upsert, including this `prev_active_now` capture) must complete **before** `runAlertRules`. The dedupe key (`A4`, routine id, local date) is the belt-and-suspenders guarantee that even a duplicated edge observation sends at most once per day.

---

## Threshold semantics

`threshold` is the third column of the dedupe composite key. It lets a single rule fire at multiple tiers / re-arm per period. What it holds per rule:

| Rule | `entityId` | `threshold` | Effect |
|------|-----------|-------------|--------|
| A1 Orphan timer | timer id | `"1"` | One alert per orphaned timer until stopped |
| A2 Task overdue | task id | `"1"` | One alert per overdue task (Phase 7 adds TTL to re-alert daily) |
| A3 Deadline soon | task id | `"1"` | One "due soon" nudge per task |
| A4 Routine start | routine id | local date `YYYY-MM-DD` | One per block start per day (re-arms daily) |
| A5 Routine missed | `digest-<date>` | local date `YYYY-MM-DD` | One digest email per day |
| A6 Budget | `expense-<YYYY-MM>` | `"80"` / `"100"` (+ `-email` for the email copy) | Each tier & channel fires once per month |
| A7 Focus goal | `focus-<date>` | local date `YYYY-MM-DD` | One evening nudge per day |

The general pattern: encode a **period** (date or month) into `entityId` or `threshold` when the rule should re-arm each period; use a constant `"1"` when it should fire once per entity for the entity's lifetime in the condition.

---

## Testing

Everything is verifiable against local D1 with `wrangler` — no phone, no live Notion, no real email needed (Resend can point at a test key or be asserted at the `alert_log` level if you also route email through `logEmail`).

### Setup

```bash
# Apply schema to local D1
wrangler d1 execute ops --local --file=./schema.sql

# Seed snapshot rows (see per-rule seeds below)
wrangler d1 execute ops --local --file=./test/seed_a1.sql

# Trigger the scheduled handler locally
wrangler dev --test-scheduled
# then hit the scheduled trigger endpoint, e.g.:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"

# Assert what fired
wrangler d1 execute ops --local \
  --command "SELECT rule, entity_id, channel, status FROM alert_log ORDER BY id;"
wrangler d1 execute ops --local \
  --command "SELECT * FROM alerts_sent;"
```

### Forcing each rule

Seed rows so each condition is true. Examples (adjust to your schema; `now` here means "relative to the test clock"):

```sql
-- A1: running timer started >3h ago, no end_time
INSERT INTO timer_snapshot (id, status, start_time, end_time, notion_url)
VALUES ('t-orphan', 'Running', '2026-07-21T05:00:00Z', '', 'https://notion.so/t-orphan');

-- A2: task deadline in the past, not completed/archived
INSERT INTO task_snapshot (id, name, deadline, completed, archived, notion_url)
VALUES ('k-late', 'Ship report', '2026-07-19T00:00:00Z', 0, 0, 'https://notion.so/k-late');

-- A3: task due within next 24h
INSERT INTO task_snapshot (id, name, deadline, completed, archived, notion_url)
VALUES ('k-soon', 'Review PR', '2026-07-21T20:00:00Z', 0, 0, 'https://notion.so/k-soon');

-- A4: rising edge — prev 0, now 1
INSERT INTO routine_snapshot (id, name, active_now, prev_active_now, today, done, notion_url)
VALUES ('r-focus', 'Deep work', 1, 0, 1, 0, 'https://notion.so/r-focus');

-- A5: routine planned today but not done (test at localHour >= 23)
INSERT INTO routine_snapshot (id, name, active_now, prev_active_now, today, done, notion_url)
VALUES ('r-gym', 'Gym', 0, 0, 1, 0, 'https://notion.so/r-gym');

-- A6: expenses at 100% of goal
INSERT INTO goals (key, amount) VALUES ('Expense Goal', 1000);
INSERT INTO txn_snapshot (id, type, amount, occurred_at)
VALUES ('x1', 'Expense', 1000, '2026-07-10T00:00:00Z');

-- A7: little/no tracked time today (test at localHour >= 21)
-- (simply have no timer rows in today's window, or a small tracked_seconds)
```

### Assertions

1. **Fires once per condition.** After one run, `alert_log` has exactly one row per triggered `(rule, entity_id, threshold)`.
2. **No double-send.** Run the scheduled handler a second time with the snapshot unchanged; assert `SELECT COUNT(*) FROM alert_log` is unchanged and `alerts_sent` has no duplicate rows.
3. **A4 edge.** After the first run (prev 0 → now 1) A4 fires. Simulate a subsequent tick by setting `prev_active_now = 1` (still active) and re-run; assert A4 does **not** fire again.
4. **A6 two tiers.** Seed expenses at 85% → only the `"80"` tier fires (push + email). Bump to 100% and re-run → the `"100"` tier fires; the `"80"` tier does not fire again.
5. **Time gates.** A5/A7 only fire when the (mockable) local hour is at/after their thresholds. Inject a fixed `now` into `makeCtx` in tests to control `localHour`.

For deterministic tests, make `makeCtx(env, now)` accept an injected `now` and pass a fixed `Date` from the test so day boundaries and hour gates are stable.

---

## Pitfalls

- **Dedupe key design.** The composite `(rule, entity_id, threshold)` must uniquely capture "this specific alert instance". Get the discriminator wrong and you either double-send (key too coarse) or never re-arm (key too fine). Encode the period into the key for rules that should re-fire per day/month (A4/A5/A7 use the date; A6 uses the month in `entityId`).

- **A4 edge-trigger ordering.** A4 depends entirely on Phase 3 populating `prev_active_now` **before** the upsert overwrites `active_now`, and on `runAlertRules` running **after** the upsert. If the upsert doesn't carry the old value, A4 either never fires (if it reads only the new value) or fires every tick (if `prev` is always 0). Verify the `ON CONFLICT DO UPDATE SET prev_active_now = routine_snapshot.active_now` behavior.

- **A6 two thresholds (and two channels).** Both tiers must be able to fire independently, and A6 dispatches on push *and* email. Because the reference dedupe key has only three columns, the channel is folded into `threshold` (`"80"`, `"80-email"`, `"100"`, `"100-email"`). Don't collapse these or one channel will suppress the other.

- **Idempotent sends (log-before/around network call).** This phase records dedupe **after** a successful dispatch and skips recording on error (so failures retry next tick). This means a crash *between* the network call succeeding and `recordSent` writing could theoretically double-send. Full idempotency treatment (writing an "attempting" log row before the call, reconciling on the next tick) is deferred to **Phase 7**. For Phase 4, the stub push has no network call, and email double-sends on rare crashes are acceptable and logged.

- **Read-only formula fields.** Fields like `active_now`, `today`, and computed rollups often originate as Notion **formula/rollup** properties. They are read-only projections snapshotted into D1 — never write back to them, and remember they can change value between syncs without any explicit user edit. Treat them as observed state, which is exactly why A4 needs the prev/now comparison.

- **No SMTP on Workers.** Cloudflare Workers cannot open SMTP sockets. Email must go over HTTPS via Resend. Don't reach for `nodemailer` or any SMTP library — it won't run.

- **Time zones.** Store UTC everywhere; only *interpret* days/hours in `env.ALERT_TZ`. The common bug is using SQLite `date('now')` (UTC) for "today", which misattributes late-evening local activity. Compute boundaries in JS from the configured TZ and bind concrete UTC instants (see `time.ts`).

- **Goal missing / division by zero.** A6 must guard `goal <= 0` (no Expense Goal configured) and return `[]` rather than dividing by zero or firing spuriously.

- **Empty vs NULL.** Notion exports often yield empty strings rather than NULL for cleared fields (e.g. `end_time = ''`). Check both `IS NULL OR = ''` where it matters (A1).
