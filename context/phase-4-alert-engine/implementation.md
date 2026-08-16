# Phase 4 — Alert Engine + Email Channel · Implementation

> **Revised 2026-08-16** for the email-only, personal-use direction. Rules E1–E9
> replace the old A1–A7. Read `context/notion-schema.md` first.

- **New code lives in:** `apps/worker/src/alerts/`
- **Schema addition:** `apps/worker/schema.sql`
- **Runtime:** Cloudflare Worker `scheduled()`, cron `* * * * *`
- **All stored timestamps are ISO 8601 UTC.** Only display and window math are local.

```
apps/worker/src/alerts/
├── types.ts        Alert, Snapshot, RuleContext
├── time.ts         Asia/Dhaka helpers — the file to get right
├── rules/
│   ├── timer.ts    E1 E2 E3
│   ├── deadline.ts E4 E5 E6 E7
│   └── routine.ts  E8 E9
├── dispatch.ts     runAlertRules, dedupe, quiet hours, recordSent
└── email.ts        Resend sender + HTML templates
```

---

## 1. Config

`wrangler.jsonc` vars (none of these are secret):

```jsonc
{
  "vars": {
    "ALERT_TZ_OFFSET_MINUTES": "360",       // Asia/Dhaka, +06:00, no DST
    "ALERT_MAX_LATENESS_MIN": "10",         // don't fire a block start >10 min late
    "ALERT_DEADLINE_STALE_HOURS": "24",     // don't fire E4/E5/E6 for long-past deadlines
    "ALERT_MISSED_GRACE_MIN": "60",         // E7 waits this long after the deadline
    "ALERT_QUIET_HOURS": "",                // e.g. "00:00-07:45"; empty = disabled
    "DIGEST_AT": "07:45",                   // E9 send time, local

    "ALERT_TIMER_START": "true",            // E1
    "ALERT_TIMER_TICK": "true",             // E2
    "ALERT_TIMER_END": "true",              // E3
    "ALERT_TIMER_TICK_MINUTES": "30",       // E2 interval
    "ALERT_DEADLINE_24H": "true",           // E4
    "ALERT_DEADLINE_1H": "true",            // E5
    "ALERT_DEADLINE_HIT": "true",           // E6
    "ALERT_DEADLINE_MISSED": "true",        // E7 — on by default, see goals.md
    "ALERT_DEADLINE_MISSED_RENAG": "true",  // E7 once/day vs once ever
    "ALERT_ROUTINE_START": "true",          // E8
    "ALERT_ROUTINE_DIGEST": "false"         // E9
  }
}
```

Secrets (`wrangler secret put`): `RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO`.

```ts
// alerts/types.ts
export interface Alert {
  rule: string;           // "E1".."E9"
  entityId: string;       // Notion page id, or a synthetic id for digests
  threshold: string;      // dedupe discriminator — see the rule table
  subject: string;
  html: string;
  notionUrl?: string;
}

export interface RuleContext {
  env: Env;
  now: Date;              // injected, never Date.now() inside a rule — keeps rules testable
}
```

Every rule is `(ctx, rows) => Alert[]`. **No rule calls the network, reads the
clock, or writes to D1.** `now` is passed in so tests can freeze it.

---

## 2. `time.ts` — the file that decides whether this works

Asia/Dhaka is **UTC+6 with no DST**, so a fixed offset is correct year-round and
avoids `Intl` entirely. The trick: shift the instant by the offset, then read
**UTC** accessors — those now report local wall-clock.

```ts
// alerts/time.ts
export function offsetMin(env: Env): number {
  return Number(env.ALERT_TZ_OFFSET_MINUTES ?? 360);
}

/** Shift an instant so that getUTC* accessors return local wall-clock fields. */
function shifted(d: Date, off: number): Date {
  return new Date(d.getTime() + off * 60_000);
}

/** Local weekday name, e.g. "Monday" — matches the routine `Days` multi-select. */
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
export function localWeekday(d: Date, off: number): string {
  return DAY_NAMES[shifted(d, off).getUTCDay()];
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date, off: number): string {
  return shifted(d, off).toISOString().slice(0, 10);
}

/** Minutes since local midnight, 0..1439. */
export function localMinutes(d: Date, off: number): number {
  const s = shifted(d, off);
  return s.getUTCHours() * 60 + s.getUTCMinutes();
}

/** Local "HH:MM" of an instant. */
export function localHHMM(d: Date, off: number): string {
  const m = localMinutes(d, off);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Build the UTC instant for a local wall-clock date + minutes-since-midnight. */
export function fromLocal(dateYMD: string, minutes: number, off: number): Date {
  const base = Date.parse(`${dateYMD}T00:00:00.000Z`);
  return new Date(base + minutes * 60_000 - off * 60_000);
}

/** Parse "HH:MM" → minutes since midnight. Returns null if malformed. */
export function parseHHMM(s: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** Parse a routine `Time` value, "HH:MM - HH:MM" → [startMin, endMin]. */
export function parseWindow(time: string): [number, number] | null {
  const parts = (time ?? "").split("-");
  if (parts.length !== 2) return null;
  const a = parseHHMM(parts[0]), b = parseHHMM(parts[1]);
  return a == null || b == null ? null : [a, b];
}

export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h}h`, m && `${m}m`, (!h && !m) && `${s}s`].filter(Boolean).join(" ");
}
```

> **Why not `Intl.DateTimeFormat` with `timeZone: "Asia/Dhaka"`?** It works on
> Workers, but it is slower, allocation-heavy at one call per row per tick, and
> returns strings you have to re-parse. A fixed offset is exact here **because
> Bangladesh observes no DST**. If you ever point this at a DST zone, swap
> `shifted()` for an `Intl`-based implementation and every caller keeps working.

---

## 3. Schema additions

Append to `apps/worker/schema.sql` (idempotent, re-appliable):

```sql
-------------------------------------------------------------------------------
-- Phase 4 (revised): timer notification bookkeeping
-------------------------------------------------------------------------------
-- Highest 30-minute bucket already emailed for a running timer. Survives Worker
-- restarts, so E2 never replays buckets after a redeploy.
ALTER TABLE timer_snapshot ADD COLUMN notified_bucket INTEGER DEFAULT 0;

-- Phase 3 writes the pre-upsert status/end_time here so E1/E3 can see the edge.
CREATE TABLE IF NOT EXISTS timer_prev (
  notion_id  TEXT PRIMARY KEY,
  status     TEXT,
  end_time   TEXT,
  seen_at    TEXT NOT NULL
);
```

`ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite — it errors if the
column exists. Either guard it in the migration runner or keep it in a separate
`migrations/004_notified_bucket.sql` applied once. Phase 7 formalises migrations.

---

## 4. E1 / E2 / E3 — timer lifecycle

```ts
// alerts/rules/timer.ts
import type { Alert, RuleContext } from "../types";
import { fmtDuration, localHHMM, offsetMin } from "../time";

export interface TimerRow {
  notion_id: string;
  name: string;
  status: string | null;        // "Running" | "Stoped"
  start_time: string | null;    // ISO
  end_time: string | null;      // ISO
  notified_bucket: number;
  task_title?: string | null;
}
export interface TimerPrev { status: string | null; end_time: string | null }

const url = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;
const isRunning = (r: TimerRow) => r.status === "Running" && !r.end_time;

/** E1 — a timer we have not seen running before is now running. */
export function ruleTimerStarted(
  ctx: RuleContext, rows: TimerRow[], prev: Map<string, TimerPrev>,
): Alert[] {
  if (ctx.env.ALERT_TIMER_START !== "true") return [];
  const off = offsetMin(ctx.env);
  const out: Alert[] = [];
  for (const r of rows) {
    if (!isRunning(r) || !r.start_time) continue;
    const p = prev.get(r.notion_id);
    // Fire when previously absent (first sight) or previously not running.
    if (p && p.status === "Running" && !p.end_time) continue;
    const started = new Date(r.start_time);
    out.push({
      rule: "E1",
      entityId: r.notion_id,
      threshold: "start",
      subject: `▶ Started: ${r.name || "Untitled timer"}`,
      html: card("Timer started", [
        ["Activity", r.name || "—"],
        ["Task", r.task_title ?? "—"],
        ["Started at", localHHMM(started, off)],
      ], url(r.notion_id)),
      notionUrl: url(r.notion_id),
    });
  }
  return out;
}

/**
 * E2 — every N minutes while a timer runs.
 * Emits only the CURRENT highest bucket. If ticks were missed, intermediate
 * buckets are skipped rather than burst-sent.
 */
export function ruleTimerTick(ctx: RuleContext, rows: TimerRow[]): Alert[] {
  if (ctx.env.ALERT_TIMER_TICK !== "true") return [];
  const step = Number(ctx.env.ALERT_TIMER_TICK_MINUTES ?? 30);
  const out: Alert[] = [];
  for (const r of rows) {
    if (!isRunning(r) || !r.start_time) continue;
    const elapsedMin = Math.floor((ctx.now.getTime() - Date.parse(r.start_time)) / 60_000);
    if (elapsedMin < step) continue;
    const bucket = Math.floor(elapsedMin / step);
    if (bucket <= r.notified_bucket) continue;      // already emailed this bucket
    const mins = bucket * step;
    out.push({
      rule: "E2",
      entityId: r.notion_id,
      threshold: `${mins}m`,
      subject: `⏳ ${fmtDuration(mins * 60)} on: ${r.name || "Untitled timer"}`,
      html: card("Timer still running", [
        ["Activity", r.name || "—"],
        ["Elapsed", fmtDuration(elapsedMin * 60)],
        ["Started", localHHMM(new Date(r.start_time), offsetMin(ctx.env))],
      ], url(r.notion_id)),
      notionUrl: url(r.notion_id),
    });
  }
  return out;
}

/** E3 — a timer that was running has stopped. */
export function ruleTimerEnded(
  ctx: RuleContext, rows: TimerRow[], prev: Map<string, TimerPrev>,
): Alert[] {
  if (ctx.env.ALERT_TIMER_END !== "true") return [];
  const off = offsetMin(ctx.env);
  const out: Alert[] = [];
  for (const r of rows) {
    const p = prev.get(r.notion_id);
    const wasRunning = p && p.status === "Running" && !p.end_time;
    if (!wasRunning || isRunning(r)) continue;
    // Notion's Total Time In Seconds is 0 until End Time exists — compute it here.
    const secs = r.start_time && r.end_time
      ? Math.max(0, Math.round((Date.parse(r.end_time) - Date.parse(r.start_time)) / 1000))
      : 0;
    out.push({
      rule: "E3",
      entityId: r.notion_id,
      threshold: "end",
      subject: `⏹ Finished: ${r.name || "Untitled timer"} — ${fmtDuration(secs)}`,
      html: card("Timer ended", [
        ["Activity", r.name || "—"],
        ["Duration", fmtDuration(secs)],
        ["Started", r.start_time ? localHHMM(new Date(r.start_time), off) : "—"],
        ["Ended", r.end_time ? localHHMM(new Date(r.end_time), off) : "—"],
      ], url(r.notion_id)),
      notionUrl: url(r.notion_id),
    });
  }
  return out;
}
```

After a successful E2 dispatch the dispatcher persists the bucket:

```sql
UPDATE timer_snapshot SET notified_bucket = ? WHERE notion_id = ?;
```

`notified_bucket` resets to 0 naturally because a *new* timer is a new row.

---

## 5. E4 / E5 / E6 / E7 — deadlines

Two shapes of `Deadline` exist in the data and they must be handled differently:

| Stored value | Length | Meaning | Deadline instant |
|---|---|---|---|
| `2026-03-31T00:00:00.000+06:00` | > 10 | exact moment | as given |
| `2026-02-22` | **10** | the whole day | local **23:59:59** of that day |

```ts
// alerts/rules/deadline.ts
import type { Alert, RuleContext } from "../types";
import { fromLocal, localDate, offsetMin } from "../time";

export interface TaskRow {
  notion_id: string;
  title: string;
  deadline: string | null;   // raw Notion value — precision preserved
  completed: number;
  archived: number;
}

const url = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;
const isDateOnly = (d: string) => d.length === 10;

/** Resolve a raw Notion deadline to a UTC instant. */
function deadlineInstant(raw: string, off: number): Date {
  return isDateOnly(raw)
    ? fromLocal(raw, 23 * 60 + 59, off)   // end of that local day
    : new Date(raw);
}

export function ruleDeadlines(ctx: RuleContext, rows: TaskRow[]): Alert[] {
  const env = ctx.env, off = offsetMin(env), now = ctx.now.getTime();
  const staleMs = Number(env.ALERT_DEADLINE_STALE_HOURS ?? 24) * 3_600_000;
  const graceMs = Number(env.ALERT_MISSED_GRACE_MIN ?? 60) * 60_000;
  const out: Alert[] = [];

  for (const r of rows) {
    if (!r.deadline || r.completed || r.archived) continue;
    const dueAt = deadlineInstant(r.deadline, off).getTime();
    const dateOnly = isDateOnly(r.deadline);
    const when = new Date(dueAt).toISOString();

    const push = (rule: string, threshold: string, subject: string, label: string) =>
      out.push({
        rule, entityId: r.notion_id, threshold, subject,
        html: card(label, [
          ["Task", r.title || "—"],
          ["Deadline", dateOnly ? r.deadline : new Date(dueAt).toISOString()],
        ], url(r.notion_id)),
        notionUrl: url(r.notion_id),
      });

    // --- E4: 24 hours out -------------------------------------------------
    // Date-only deadlines anchor to 09:00 the previous local day instead of
    // 23:59 the previous day, which would be a useless midnight ping.
    if (env.ALERT_DEADLINE_24H === "true") {
      const fireAt = dateOnly
        ? fromLocal(localDate(new Date(dueAt - 86_400_000), off), 9 * 60, off).getTime()
        : dueAt - 86_400_000;
      // Only while still upcoming, and not for deadlines already long past.
      if (now >= fireAt && now < dueAt && now - fireAt < staleMs) {
        push("E4", "24h", `⏰ Due in 24h: ${r.title}`, "Deadline approaching");
      }
    }

    // --- E5: 1 hour out — meaningless for a date-only deadline ------------
    if (env.ALERT_DEADLINE_1H === "true" && !dateOnly) {
      const fireAt = dueAt - 3_600_000;
      if (now >= fireAt && now < dueAt && now - fireAt < staleMs) {
        push("E5", "1h", `⏰ Due in 1 hour: ${r.title}`, "Deadline in one hour");
      }
    }

    // --- E6: the deadline itself -----------------------------------------
    if (env.ALERT_DEADLINE_HIT === "true") {
      if (now >= dueAt && now - dueAt < staleMs) {
        push("E6", "hit", `🔔 Deadline reached: ${r.title}`, "Deadline reached");
      }
    }

    // --- E7: missed -------------------------------------------------------
    if (env.ALERT_DEADLINE_MISSED === "true" && now >= dueAt + graceMs) {
      // Date in the threshold ⇒ one nag per day. Without it, one nag ever.
      const threshold = env.ALERT_DEADLINE_MISSED_RENAG === "true"
        ? `missed:${localDate(ctx.now, off)}`
        : "missed";
      const daysLate = Math.floor((now - dueAt) / 86_400_000);
      push("E7", threshold,
        `❗ Overdue${daysLate > 0 ? ` by ${daysLate}d` : ""}: ${r.title}`,
        "Deadline missed");
    }
  }
  return out;
}
```

The `staleMs` guard is what stops a newly-added task with a deadline from 2026-02
firing E4, E5 and E6 all at once the moment it syncs. E7 has no such guard on
purpose — an overdue task *should* nag.

---

## 6. E8 / E9 — routine

E8 does **not** read Notion's `Active Now`. See `goals.md` for why that formula
can never drive an edge trigger.

```ts
// alerts/rules/routine.ts
import type { Alert, RuleContext } from "../types";
import { localDate, localMinutes, localWeekday, offsetMin, parseWindow } from "../time";

export interface RoutineRow {
  notion_id: string;
  activity: string;
  time: string;          // "HH:MM - HH:MM"
  days: string[];        // ["Sunday", ...]
  archived: number;
  done: number;
}

const url = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;
const pad = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * E8 — a routine block just started.
 *
 * Fires when local wall-clock is within ALERT_MAX_LATENESS_MIN *after* a block's
 * start. The lateness window (rather than an exact minute match) means a skipped
 * or delayed cron tick still delivers, while a Worker deployed mid-afternoon does
 * not retroactively announce the morning's blocks.
 */
export function ruleRoutineStart(ctx: RuleContext, rows: RoutineRow[]): Alert[] {
  if (ctx.env.ALERT_ROUTINE_START !== "true") return [];
  const off = offsetMin(ctx.env);
  const maxLate = Number(ctx.env.ALERT_MAX_LATENESS_MIN ?? 10);
  const nowMin = localMinutes(ctx.now, off);
  const out: Alert[] = [];

  for (const r of rows) {
    if (r.archived) continue;
    const win = parseWindow(r.time);
    if (!win) continue;                       // malformed Time — skip, don't throw
    const [startMin, endMin] = win;

    // Minutes since this block's start, wrapping across midnight.
    let since = nowMin - startMin;
    if (since < 0) since += 1440;
    if (since > maxLate) continue;

    // The block's OWN start instant — for a 23:55 block observed at 00:02 the
    // start belongs to yesterday. Both the weekday check and the dedupe key
    // must use that date, not today's.
    const startInstant = new Date(ctx.now.getTime() - since * 60_000);
    const startDate = localDate(startInstant, off);
    if (!r.days.includes(localWeekday(startInstant, off))) continue;

    out.push({
      rule: "E8",
      entityId: r.notion_id,
      threshold: `${startDate}T${pad(startMin)}`,   // once per block per day
      subject: `🟢 ${r.activity} — ${pad(startMin)} to ${pad(endMin)}`,
      html: card("Routine block started", [
        ["Activity", r.activity || "—"],
        ["Window", `${pad(startMin)} – ${pad(endMin)}`],
        ["Day", localWeekday(startInstant, off)],
      ], url(r.notion_id)),
      notionUrl: url(r.notion_id),
    });
  }
  return out;
}

/** E9 — one digest of the whole day's schedule. Off by default. */
export function ruleRoutineDigest(ctx: RuleContext, rows: RoutineRow[]): Alert[] {
  if (ctx.env.ALERT_ROUTINE_DIGEST !== "true") return [];
  const off = offsetMin(ctx.env);
  const at = (ctx.env.DIGEST_AT ?? "07:45").split(":");
  const atMin = Number(at[0]) * 60 + Number(at[1]);
  const nowMin = localMinutes(ctx.now, off);
  const maxLate = Number(ctx.env.ALERT_MAX_LATENESS_MIN ?? 10);
  if (nowMin < atMin || nowMin - atMin > maxLate) return [];

  const today = localWeekday(ctx.now, off);
  const blocks = rows
    .filter((r) => !r.archived && r.days.includes(today) && parseWindow(r.time))
    .sort((a, b) => parseWindow(a.time)![0] - parseWindow(b.time)![0]);

  if (blocks.length === 0) return [];   // Fri/Sat under the current data

  const list = blocks.map((b) => {
    const [s, e] = parseWindow(b.time)!;
    return `<tr><td style="padding:4px 12px 4px 0;color:#9aa3b2;white-space:nowrap">${pad(s)} – ${pad(e)}</td><td style="padding:4px 0">${esc(b.activity)}</td></tr>`;
  }).join("");

  return [{
    rule: "E9",
    entityId: "routine-digest",
    threshold: localDate(ctx.now, off),
    subject: `📅 ${today} — ${blocks.length} routine blocks`,
    html: `<h2 style="font:600 16px system-ui;margin:0 0 12px">Today's routine — ${today}</h2><table style="font:14px system-ui;border-collapse:collapse">${list}</table>`,
  }];
}
```

---

## 7. Dispatcher

```ts
// alerts/dispatch.ts
import { localMinutes, offsetMin, parseHHMM } from "./time";
import { sendEmail } from "./email";
import type { Alert, RuleContext } from "./types";

/** True when `now` falls inside ALERT_QUIET_HOURS. Empty var ⇒ always false. */
function inQuietHours(ctx: RuleContext): boolean {
  const raw = ctx.env.ALERT_QUIET_HOURS ?? "";
  if (!raw.includes("-")) return false;
  const [a, b] = raw.split("-");
  const from = parseHHMM(a), to = parseHHMM(b);
  if (from == null || to == null) return false;
  const n = localMinutes(ctx.now, offsetMin(ctx.env));
  return from <= to ? n >= from && n < to : n >= from || n < to;  // handles wrap
}

export async function runAlertRules(env: Env, now = new Date()): Promise<void> {
  const ctx: RuleContext = { env, now };
  const { timers, prev, tasks, routines } = await loadSnapshot(env);

  const candidates: Alert[] = [
    ...ruleTimerStarted(ctx, timers, prev),
    ...ruleTimerTick(ctx, timers),
    ...ruleTimerEnded(ctx, timers, prev),
    ...ruleDeadlines(ctx, tasks),
    ...ruleRoutineStart(ctx, routines),
    ...ruleRoutineDigest(ctx, routines),
  ];

  const quiet = inQuietHours(ctx);

  for (const a of candidates) {
    // Dedupe on the composite key. This is what makes a rule that stays true
    // for 60 ticks send exactly one email.
    const seen = await env.DB.prepare(
      `SELECT 1 FROM alerts_sent WHERE rule=? AND entity_id=? AND threshold=?`,
    ).bind(a.rule, a.entityId, a.threshold).first();
    if (seen) continue;

    if (quiet) {
      // Record it as suppressed so the dedupe key is consumed and the audit
      // trail shows *why* nothing arrived — silent drops are undebuggable.
      await recordSent(env, a, "suppressed", now);
      continue;
    }

    let status = "sent";
    try {
      await sendEmail(env, a.subject, a.html);
    } catch (e) {
      status = `error: ${(e as Error).message}`.slice(0, 200);
    }
    await recordSent(env, a, status, now);

    // E2 only: persist the bucket so a redeploy can't replay it.
    if (a.rule === "E2" && status === "sent") {
      const mins = Number(a.threshold.replace("m", ""));
      const step = Number(env.ALERT_TIMER_TICK_MINUTES ?? 30);
      await env.DB.prepare(
        `UPDATE timer_snapshot SET notified_bucket=? WHERE notion_id=?`,
      ).bind(Math.floor(mins / step), a.entityId).run();
    }
  }
}

async function recordSent(env: Env, a: Alert, status: string, now: Date) {
  const ts = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO alerts_sent (rule, entity_id, threshold, sent_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(a.rule, a.entityId, a.threshold, ts),
    env.DB.prepare(
      `INSERT INTO alert_log (rule, entity_id, channel, message, status, sent_at)
       VALUES (?, ?, 'email', ?, ?, ?)`,
    ).bind(a.rule, a.entityId, a.subject, status, ts),
  ]);
}
```

> **Failure ordering.** A send that throws still writes `alerts_sent`, so a
> transient Resend outage costs you that one notification rather than looping
> forever. `alert_log.status` carries the error. Phase 7 revisits this with a
> bounded retry; for a personal tool, dropping one email beats a retry storm.

---

## 8. Email via Resend

```ts
// alerts/email.ts
export async function sendEmail(env: Env, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.ALERT_FROM,     // "Notion Ops <onboarding@resend.dev>" works untested-domain
      to: [env.ALERT_TO],
      subject,
      html: shell(html),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Shared card body used by the rule templates. */
export function card(title: string, fields: [string, string][], link?: string): string {
  const rows = fields.map(([k, v]) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#9aa3b2;white-space:nowrap">${esc(k)}</td>` +
    `<td style="padding:4px 0;color:#e6e8ee">${esc(v)}</td></tr>`).join("");
  const cta = link
    ? `<p style="margin:16px 0 0"><a href="${esc(link)}" style="color:#6ea8fe">Open in Notion →</a></p>`
    : "";
  return `<h2 style="font:600 16px system-ui;margin:0 0 12px;color:#e6e8ee">${esc(title)}</h2>`
       + `<table style="font:14px system-ui;border-collapse:collapse">${rows}</table>${cta}`;
}

function shell(inner: string): string {
  return `<div style="background:#0d0f14;padding:24px;font-family:system-ui,sans-serif">`
       + `<div style="max-width:32rem;margin:0 auto;background:#161a22;border:1px solid #232a36;`
       + `border-radius:12px;padding:20px">${inner}</div></div>`;
}
```

**Resend on the free tier:** `onboarding@resend.dev` is a usable `from` without
verifying a domain, but it can only deliver to **the address that owns the Resend
account**. Since `ALERT_TO` is your own inbox, that is sufficient. Verify a domain
later only if you want a custom `From`.

Set the secrets:

```powershell
echo "re_xxxxxxxxxxxx"                        | npx wrangler secret put RESEND_API_KEY
echo "Notion Ops <onboarding@resend.dev>"     | npx wrangler secret put ALERT_FROM
echo "sami999khan999@gmail.com"               | npx wrangler secret put ALERT_TO
```

---

## 9. Phase 3 coordination

`scheduled()` must capture the previous timer state **before** upserting:

```ts
async function runSync(env: Env) {
  // 1. Snapshot the pre-upsert timer state so E1/E3 can see transitions.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO timer_prev (notion_id, status, end_time, seen_at)
     SELECT notion_id, status, end_time, datetime('now') FROM timer_snapshot`,
  ).run();

  // 2. Pull + upsert (tasks & timers incremental; routine full — see below).
  await pullAndUpsertTimers(env);
  await pullAndUpsertTasks(env);
  await pullAndUpsertRoutine(env);

  // 3. Rules run against the fresh snapshot with timer_prev still holding the old state.
  await runAlertRules(env);
}
```

**Routine is pulled in full every tick, not incrementally.** 20 active rows is one
query, and an incremental cursor would be actively wrong here: routine rows are
edited rarely, so a `last_edited_time` filter would return nothing on almost every
tick while the blocks still need evaluating. E8 needs the *rows*, not the *edits*.

Tasks (359) and Time Tracker (162) keep the incremental cursor, overlapped by
~2 minutes per Phase 7 — `last_edited_time` has **minute granularity**, so a
zero-overlap cursor can drop an edit that lands in the same minute as the cursor.

---

## 10. Verification

| Exit criterion | Test |
|---|---|
| E8 fires at the right local minute | Freeze `now` to `2026-08-17T03:00:00Z` (= Monday 09:00 Dhaka). Assert exactly one E8, for the `09:00 - 13:00 Work` block. At `03:11:00Z` (09:11, past the 10-min window) assert zero. |
| **Timezone regression guard** | Run the same test with `ALERT_TZ_OFFSET_MINUTES=0`. It **must fail** — if it passes, the offset is not being applied and every routine email is six hours off. |
| E8 midnight wrap | Freeze to Tuesday `00:02` local. The `23:55 - 00:00 Exercise` block fires with threshold dated **Monday**, not Tuesday. |
| Fri/Sat silence | Freeze to any Friday. Assert zero E8 candidates (all Fri rows archived). |
| E2 buckets | Seed a running timer started 95 min ago with `notified_bucket=0`. Assert one candidate, `90m`. Set `notified_bucket=3`, assert none. |
| E1/E3 edges | Seed `timer_prev.status='Stoped'`, snapshot `Running` → one E1. Re-run with prev now `Running` → zero. Flip snapshot to `Stoped` + `end_time` → one E3. |
| E5 skips date-only | Seed `deadline='2026-02-22'`. Assert E4/E6/E7 possible, **never** E5. |
| Stale-deadline guard | Seed a deadline 30 days past. Assert E4/E5/E6 all silent, E7 fires. |
| Dedupe | Run any tick twice unchanged. Second run adds zero `alert_log` rows. |
| Quiet hours | Set `ALERT_QUIET_HOURS=00:00-07:45`, freeze to 02:00. Candidates get `alert_log.status='suppressed'` and no Resend call. |

Because every rule takes `now` as a parameter, all of this runs as plain unit
tests against a seeded local D1 — no waiting on real clocks.

---

## 11. Pitfalls

1. **Never build an edge trigger on a Notion formula.** `Active Now`,
   `Total Time In Seconds Today`, `Time Remains`, `Schedule Status` all change
   with the clock without touching `last_edited_time`. They are display values.
   Compute triggers locally.

2. **`Total Time In Seconds` is 0 while a timer runs.** The formula guards on
   `End Time`. Compute live elapsed as `now − Start Time` yourself (E2 does).

3. **Filter Time Tracker `Status` by option name, never by group.** Its groups
   are miswired — `Running` sits under **Complete**. `status: {equals: "Running"}`
   is correct; anything group-based is not.

4. **Tasks `Status` is not task state.** All 359 rows are `Stoped`. Never gate a
   rule on it.

5. **Deadline precision is mixed.** Branch on `length === 10`. A date-only value
   has no time, so "1 hour before" is meaningless — E5 skips it.

6. **The dedupe threshold must contain a date for anything recurring.** E8's key
   is `YYYY-MM-DDTHH:MM`. Drop the date and each block fires once *ever*, then
   goes permanently silent the next day. This is the single easiest way to
   silently break the whole routine feature.

7. **Use the block's own start date in the dedupe key**, not today's — otherwise
   the `23:55` block observed at `00:02` gets tomorrow's key and can double-fire.

8. **`ALTER TABLE ADD COLUMN` is not idempotent** in SQLite. Keep it in a
   numbered migration, not in the re-appliable `schema.sql`.

9. **Local and remote D1 are separate stores.** Seeded test rows and
   `alerts_sent` history exist independently in each.

10. **Escape interpolated Notion text in HTML.** Activity and task titles are
    user-controlled; `card()` escapes via `esc()`. Do not hand-build template
    strings that skip it.

11. **Notion `last_edited_time` is minute-granular.** Detection of a timer start
    lands 1–2 minutes after the fact. That is a hard floor on E1 latency — cron
    frequency cannot improve it.
