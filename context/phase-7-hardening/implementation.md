# Phase 7 — Hardening · Implementation

Concrete, copy-pasteable implementation for each hardening item. Each section
has: **the change**, **the code/SQL**, **testing/validation**, and **pitfalls**.
A production-readiness checklist closes the document.

Assumed bindings (from earlier phases) in `wrangler.toml`:

```toml
name = "notion-ops-dashboard"
main = "src/worker.ts"
compatibility_date = "2026-01-15"

[[d1_databases]]
binding = "DB"
database_name = "notion_ops"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[triggers]
crons = ["*/5 * * * *"]      # main pipeline every 5 minutes

[observability]
enabled = true               # <-- Phase 7, see §7
```

Env type used throughout:

```ts
interface Env {
  DB: D1Database;
  NOTION_TOKEN: string;      // secret
  RESEND_API_KEY: string;    // secret
  FCM_SA_JSON: string;       // secret (service account JSON)
  // non-sensitive config may live in [vars]:
  NOTION_DB_ID: string;
}
```

---

## §1 — Dedupe TTL: prune `alerts_sent`

### Schema (add a fired-at timestamp if not already present)

`alerts_sent` keys on `(rule, entity_id, threshold)`. To prune by age we need to
know *when* each row was written. If Phase 5 did not add it, add `fired_at`:

```sql
-- Migration: add fired-at to alerts_sent (idempotent-ish; guard in a migration file)
ALTER TABLE alerts_sent ADD COLUMN fired_at INTEGER NOT NULL DEFAULT (unixepoch());
-- fired_at stored as unix epoch seconds (UTC).
CREATE INDEX IF NOT EXISTS idx_alerts_sent_fired_at ON alerts_sent (fired_at);
```

When the pipeline inserts a dedupe row, set `fired_at = now`:

```ts
await env.DB.prepare(
  `INSERT OR IGNORE INTO alerts_sent (rule, entity_id, threshold, fired_at)
   VALUES (?1, ?2, ?3, ?4)`
).bind(rule, entityId, threshold, nowSecs).run();
```

### Per-rule TTL strategy

Not every rule should reset. A recurring condition (still overdue) should
re-alert daily; a one-shot transition (moved to Done) should alert exactly once,
ever. Encode the policy in one table:

| Rule | Kind | TTL policy | Prune behavior |
|------|------|-----------|----------------|
| `overdue_task` | recurring | daily | prune rows before start-of-today |
| `budget_overrun` | recurring | daily | prune rows before start-of-today |
| `stale_in_progress` | recurring | daily | prune rows before start-of-today |
| `sla_breach` | recurring | daily | prune rows before start-of-today |
| `unassigned_high_priority` | recurring | daily | prune rows before start-of-today |
| `status_transition` | once-ever | never | never pruned |
| `entered_terminal_state` | once-ever | never | never pruned |

Represent it in code so the prune query is data-driven:

```ts
// TTL in hours; null = never prune (once-ever rules).
export const RULE_TTL_HOURS: Record<string, number | null> = {
  overdue_task: 24,
  budget_overrun: 24,
  stale_in_progress: 24,
  sla_breach: 24,
  unassigned_high_priority: 24,
  status_transition: null,
  entered_terminal_state: null,
};
```

### Prune query

Two valid designs — pick one:

**A. Prune by "older than today" (calendar-day reset).** Simplest mental model:
anything fired before local midnight is eligible, so the first run after midnight
lets recurring rules re-fire.

```sql
-- Delete daily-recurring dedupe rows fired before the start of today (UTC).
DELETE FROM alerts_sent
WHERE rule IN ('overdue_task','budget_overrun','stale_in_progress',
               'sla_breach','unassigned_high_priority')
  AND fired_at < unixepoch('now', 'start of day');
```

**B. Prune by rolling age (older than N hours).** More uniform; "re-fire ~24h
after last fire" rather than "at midnight."

```sql
DELETE FROM alerts_sent
WHERE rule IN ('overdue_task','budget_overrun','stale_in_progress',
               'sla_breach','unassigned_high_priority')
  AND fired_at < unixepoch('now') - (24 * 3600);
```

We recommend **Design A** (calendar reset) — it matches how people think about
"daily digests" and makes the exit criterion ("re-fire next day, not same day")
literally true.

### Data-driven prune helper

```ts
export async function pruneAlertsSent(env: Env, now: number): Promise<number> {
  const dailyRules = Object.entries(RULE_TTL_HOURS)
    .filter(([, ttl]) => ttl !== null)
    .map(([rule]) => rule);

  if (dailyRules.length === 0) return 0;

  const placeholders = dailyRules.map((_, i) => `?${i + 1}`).join(",");
  const res = await env.DB.prepare(
    `DELETE FROM alerts_sent
       WHERE rule IN (${placeholders})
         AND fired_at < unixepoch('now','start of day')`
  ).bind(...dailyRules).run();

  const deleted = res.meta.changes ?? 0;
  logEvent("prune_alerts_sent", { deleted, rules: dailyRules });
  return deleted;
}
```

### When to run the prune (cron-guarded by date)

Run it once per day. Two options:

**Option 1 — separate cron** (cleanest):

```toml
[triggers]
crons = [
  "*/5 * * * *",   # main pipeline
  "10 0 * * *"     # daily maintenance at 00:10 UTC
]
```

Then branch on the cron pattern inside `scheduled()`:

```ts
export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "10 0 * * *") {
      await runDailyMaintenance(env);   // prune alerts_sent + purge tokens (§2)
      return;
    }
    await runPipeline(env, ctx);         // the main run
  },
};
```

**Option 2 — guard by date inside the main run** (no extra cron). Keep a
`sync_state` key `last_prune_date`; run the prune only when it differs from
today:

```ts
async function maybeDailyMaintenance(env: Env, now: number) {
  const today = new Date(now * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const row = await env.DB.prepare(
    `SELECT value FROM sync_state WHERE key = 'last_prune_date'`
  ).first<{ value: string }>();
  if (row?.value === today) return;      // already pruned today

  await pruneAlertsSent(env, now);
  await purgeStaleTokens(env);           // §2
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value) VALUES ('last_prune_date', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(today).run();
}
```

### Testing / validation
- **Re-fire next day:** insert an `alerts_sent` row with
  `fired_at = unixepoch('now','-1 day')`, run the prune, confirm the row is gone
  and the next pipeline run re-fires the alert.
- **No re-fire same day:** insert a row with `fired_at = unixepoch('now')`, run
  the prune, confirm it survives and the rule is deduped on the next run.
- **Once-ever untouched:** insert a `status_transition` row dated a year ago; run
  the prune; confirm it survives.
- Query to inspect: `SELECT rule, count(*), min(fired_at), max(fired_at) FROM
  alerts_sent GROUP BY rule;`

### Pitfalls
- **TTL too aggressive** (e.g. pruning every run, or a 1h TTL on a rule that
  should be daily) → re-fires too soon → notification spam. Default to daily.
- **TTL too lax / forgotten** → recurring alerts silently never re-fire. The
  most dangerous failure because nothing errors. The "re-fire next day" test
  guards against it.
- **Timezone drift:** `start of day` is UTC in SQLite. If the audience is in a
  specific timezone, offset accordingly (`unixepoch('now','start of
  day','-8 hours')`) or the "daily" reset lands mid-afternoon locally.

---

## §2 — Stale push token purge

Phase 6 already deactivates on FCM rejection. Verify it:

```ts
// Inside pushFcm, on error response:
if (status === 404 || status === 400) {
  await env.DB.prepare(
    `UPDATE device_tokens SET active = 0, deactivated_at = unixepoch()
       WHERE token = ?1`
  ).bind(token).run();
}
```

(If `deactivated_at` does not exist, add it — we need it to age out rows:)

```sql
ALTER TABLE device_tokens ADD COLUMN deactivated_at INTEGER;
```

### Purge query

```sql
-- Physically delete tokens deactivated more than 30 days ago.
DELETE FROM device_tokens
WHERE active = 0
  AND deactivated_at IS NOT NULL
  AND deactivated_at < unixepoch('now') - (30 * 24 * 3600);
```

```ts
export async function purgeStaleTokens(env: Env, retentionDays = 30): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM device_tokens
       WHERE active = 0
         AND deactivated_at IS NOT NULL
         AND deactivated_at < unixepoch('now') - (?1 * 24 * 3600)`
  ).bind(retentionDays).run();
  const deleted = res.meta.changes ?? 0;
  logEvent("purge_tokens", { deleted, retentionDays });
  return deleted;
}
```

Call it from `runDailyMaintenance` / `maybeDailyMaintenance` (see §1).

### Testing / validation
- Insert `active=0, deactivated_at = unixepoch('now','-31 day')` → purge → gone.
- Insert `active=0, deactivated_at = unixepoch('now','-1 day')` → purge → kept
  (still inside retention window, useful for debugging).
- Insert `active=1` → purge → never deleted.

### Pitfalls
- Do **not** delete on deactivation directly — the retention window is what lets
  you answer "why did this device stop receiving alerts?" for 30 days.
- Ensure `deactivated_at` is set whenever `active` flips to 0, or rows with a
  NULL timestamp will never be purged.

---

## §3 — Incremental correctness: cursor overlap

The cursor lives in `sync_state` (key `last_cursor`, an ISO timestamp compared
against Notion's `last_edited_time`). The fix is to subtract 120 seconds when
writing it.

### Code diff — `setCursor`

```diff
 export async function setCursor(env: Env, runStartMs: number): Promise<void> {
-  // BUG: storing the exact run-start time misses edits made during the run.
-  const cursorMs = runStartMs;
+  // Overlap by 120s so pages edited *during* this run are re-seen next run.
+  // Re-processing the overlap is safe: upserts are idempotent (Phase 3),
+  // alerts are deduped (Phase 5).
+  const OVERLAP_MS = 120_000;
+  const cursorMs = runStartMs - OVERLAP_MS;
   const cursorIso = new Date(cursorMs).toISOString();
   await env.DB.prepare(
     `INSERT INTO sync_state (key, value) VALUES ('last_cursor', ?1)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`
   ).bind(cursorIso).run();
 }
```

Capture `runStart` at the very top of the run (before any Notion I/O) and pass it
to `setCursor` only **after** the sync loop completes successfully — never
advance the cursor on a failed/partial run:

```ts
const runStart = Date.now();
try {
  await syncNotion(env, runStart);   // pages the DB filtered by last_cursor
  await setCursor(env, runStart);    // advance with overlap, only on success
} catch (err) {
  logEvent("sync_failed", { error: String(err) });
  // cursor intentionally left un-advanced → next run retries the window
  throw err;
}
```

The Notion query uses the stored cursor:

```ts
filter: {
  timestamp: "last_edited_time",
  last_edited_time: { after: cursorIso }   // strict '>' semantics
}
```

### Testing / validation
- **Force a boundary case:** during a manual run, edit a Notion page in the
  window between `runStart` and the loop finishing (or simulate by manually
  setting `last_cursor` to a time *after* a known page's `last_edited_time`).
  With the old code the page is skipped forever; with overlap it reappears next
  run. Confirm the snapshot row updates.
- **Confirm re-processing is harmless:** run twice back-to-back; verify no
  duplicate snapshot rows (`SELECT entity_id, count(*) ... GROUP BY entity_id
  HAVING count(*) > 1` returns nothing) and no duplicate alerts.

### Pitfalls
- The overlap **causes deliberate re-processing** of recently-edited pages every
  run. This is fine *only because upserts are idempotent and alerts are deduped*.
  If either guarantee regresses, the overlap turns into duplicate work/alerts.
- Do not make the overlap huge "to be safe" — a 2-hour overlap re-processes 2
  hours of edits every run, wasting subrequests. 120s comfortably covers a normal
  run duration; tune only if runs approach that length.

---

## §4 — Rate limits: `notionFetchWithRetry` + page cap

### The wrapper

```ts
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 20_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch a Notion endpoint, honoring 429 Retry-After and backing off on 5xx.
 * Throws after MAX_ATTEMPTS so a persistent failure surfaces instead of looping.
 */
export async function notionFetchWithRetry(
  url: string,
  init: RequestInit,
  env: Env
): Promise<Response> {
  let attempt = 0;
  // ensure auth + version headers are always present
  const headers = {
    ...init.headers,
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };

  while (true) {
    attempt++;
    const res = await fetch(url, { ...init, headers });

    // Success
    if (res.ok) return res;

    // Rate limited: honor Retry-After (seconds), fall back to backoff.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoffMs(attempt);
      logEvent("notion_429", { attempt, waitMs });
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Notion 429 after ${attempt} attempts`);
      }
      await sleep(waitMs);
      continue;
    }

    // Transient server errors: exponential backoff.
    if (res.status >= 500 && res.status < 600) {
      logEvent("notion_5xx", { attempt, status: res.status });
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Notion ${res.status} after ${attempt} attempts`);
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    // Non-retryable (400/401/403/404): fail fast with body for diagnosis.
    const body = await res.text().catch(() => "");
    throw new Error(`Notion ${res.status}: ${body.slice(0, 500)}`);
  }
}

/** Exponential backoff with full jitter, capped. */
function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exp); // full jitter
}
```

### Page cap per run

Bound how many pages a single invocation processes; defer the rest to the next
run (the cursor is only advanced on success, so unprocessed edits are re-queried
next time — but see the pitfall about partial pages).

```ts
const MAX_PAGES_PER_RUN = 300;   // keep subrequests well under Workers cap (1000)

export async function syncNotion(env: Env, runStart: number) {
  let cursor: string | undefined;   // Notion pagination cursor (not our time cursor)
  let processed = 0;
  const lastEdited = await getCursor(env); // ISO time filter

  do {
    const res = await notionFetchWithRetry(
      "https://api.notion.com/v1/databases/" + env.NOTION_DB_ID + "/query",
      {
        method: "POST",
        body: JSON.stringify({
          filter: { timestamp: "last_edited_time",
                    last_edited_time: { after: lastEdited } },
          sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
          start_cursor: cursor,
          page_size: 100,
        }),
      },
      env
    );
    const page = await res.json<NotionQueryResponse>();

    for (const item of page.results) {
      await upsertSnapshot(env, item);   // idempotent
      processed++;
    }

    cursor = page.has_more ? page.next_cursor : undefined;

    if (processed >= MAX_PAGES_PER_RUN) {
      logEvent("page_cap_hit", { processed });
      break;   // remainder handled next run
    }
  } while (cursor);

  logEvent("sync_done", { processed });
}
```

### Testing / validation
- **Simulate a 429:** temporarily point the wrapper at a mock endpoint that
  returns `429` with `Retry-After: 2` for the first 2 attempts then `200`.
  Confirm the wrapper waits ~2s each time and eventually succeeds. A quick local
  mock:

  ```ts
  // test double
  let n = 0;
  globalThis.fetch = async () =>
    (n++ < 2)
      ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
      : new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });
  ```

- **Verify max-attempts fail-fast:** make the mock always return `429`; confirm
  it throws after `MAX_ATTEMPTS` rather than hanging.
- **Verify page cap:** seed >`MAX_PAGES_PER_RUN` changed pages; confirm one run
  processes the cap, logs `page_cap_hit`, and a second run drains the rest.
- **Subrequest budget:** count `fetch` calls per run in logs; confirm < 1000.

### Pitfalls
- **`Retry-After` may be absent or non-numeric** — always fall back to computed
  backoff (handled above).
- **Page cap + `ascending` sort matters:** sort by `last_edited_time ascending`
  so a capped run processes the *oldest* unseen edits first; otherwise the cursor
  overlap logic and "defer remainder" don't compose cleanly. Because the time
  cursor only advances on full success, a capped run should **not** advance past
  the last fully-processed page's edit time — simplest safe choice is to only
  call `setCursor(runStart)` when the loop drained naturally (not on
  `page_cap_hit`); on a capped run, leave the cursor so the next run resumes.
- **No `setTimeout` abuse:** long sleeps count against wall-clock and CPU budget.
  Keep `MAX_BACKOFF_MS` modest; a huge Retry-After should abort the run and let
  the next cron retry rather than sleep 60s inside one invocation.

---

## §5 — Idempotent sends: `alert_log` pending → sent/failed

### The pattern

```ts
type Channel = "fcm" | "email";

export async function sendAlertIdempotent(
  env: Env,
  args: {
    rule: string;
    entityId: string;
    threshold: string;
    channel: Channel;
    target: string;   // token or email
    payload: AlertPayload;
  }
): Promise<"sent" | "failed" | "deduped"> {
  const { rule, entityId, threshold, channel, target, payload } = args;
  const now = Math.floor(Date.now() / 1000);

  // 1) Dedupe gate: claim (rule, entity, threshold). If already present, stop.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO alerts_sent (rule, entity_id, threshold, fired_at)
     VALUES (?1, ?2, ?3, ?4)`
  ).bind(rule, entityId, threshold, now).run();

  if ((claim.meta.changes ?? 0) === 0) {
    logEvent("alert_deduped", { rule, entityId, threshold });
    return "deduped";     // already fired this window → do not send
  }

  // 2) Write audit row as 'pending' BEFORE the network call.
  const logId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO alert_log (id, rule, entity_id, threshold, channel, target, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`
  ).bind(logId, rule, entityId, threshold, channel, target, now).run();

  // 3) The network call.
  let status: "sent" | "failed" = "failed";
  let detail = "";
  try {
    if (channel === "fcm") {
      await pushFcm(env, target, payload);      // Phase 6 real sender
    } else {
      await sendResend(env, target, payload);   // Phase 6 email
    }
    status = "sent";
  } catch (err) {
    detail = String(err);
    // A hard failure means this window did NOT deliver. Roll back the dedupe
    // claim so the next run can retry (otherwise a transient failure silently
    // suppresses the alert for the whole TTL window).
    await env.DB.prepare(
      `DELETE FROM alerts_sent WHERE rule=?1 AND entity_id=?2 AND threshold=?3`
    ).bind(rule, entityId, threshold).run();
  }

  // 4) Finalize the audit row.
  await env.DB.prepare(
    `UPDATE alert_log SET status = ?1, detail = ?2, updated_at = ?3 WHERE id = ?4`
  ).bind(status, detail.slice(0, 500), Math.floor(Date.now() / 1000), logId).run();

  logEvent("alert_send", { rule, entityId, threshold, channel, status });
  return status;
}
```

Why this is idempotent across a retried `scheduled()` invocation:
- The `INSERT OR IGNORE` into `alerts_sent` is the **claim**. The first attempt
  wins; a retry sees `changes === 0` and returns `deduped` **before** touching
  the network → no double send.
- The `alert_log` `pending` row is written **before** the send, so even a run
  that dies mid-send leaves a durable trace (`pending`) that an operator can
  reconcile.
- On a genuine failure we **release the claim** so the alert isn't lost for the
  whole TTL window; the trade-off (a retry could double-send if the first send
  actually succeeded but the response was lost) is acceptable for these alerts
  and is bounded — the `pending` row flags it for inspection.

### `alert_log` schema (Phase 5, extended)

```sql
CREATE TABLE IF NOT EXISTS alert_log (
  id          TEXT PRIMARY KEY,
  rule        TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  threshold   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  target      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  detail      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alert_log_status ON alert_log (status, created_at);
```

### Testing / validation
- **No double-send on retry:** call `sendAlertIdempotent` twice with identical
  args (simulating a retried invocation). First returns `sent`, second returns
  `deduped`, and the mock sender is invoked exactly once.
- **Stuck-pending detection:** kill the process after the `pending` insert but
  before finalize (or mock the sender to hang then throw). Confirm a `pending`
  row remains and is visible via `SELECT * FROM alert_log WHERE status='pending'
  AND created_at < unixepoch('now')-300`.
- **Failure releases claim:** make the sender throw; confirm the `alerts_sent`
  row is deleted and a subsequent run re-attempts.

### Pitfalls
- **Ordering is the whole point:** claim → pending → send → finalize. Writing the
  dedupe row *after* the send reopens the double-send window.
- **D1 has no multi-statement transaction across `await` fetch** — you cannot
  wrap the network call in a DB transaction. That is exactly why we use the
  claim-first pattern instead of a transaction.
- **Deciding whether to release the claim on failure** is a policy call: release
  = "prefer re-attempt, risk rare duplicate"; keep = "prefer no duplicate, risk
  missing this window." Document whichever you choose; above we release.

---

## §6 — Secrets audit

### Store everything token-like as a secret

```bash
wrangler secret put NOTION_TOKEN
wrangler secret put RESEND_API_KEY
wrangler secret put FCM_SA_JSON          # paste the full service-account JSON
```

Local development uses `.dev.vars` (never committed):

```bash
# .dev.vars  (gitignored)
NOTION_TOKEN="secret_xxx"
RESEND_API_KEY="re_xxx"
FCM_SA_JSON='{"type":"service_account", ...}'
```

`.gitignore` must contain:

```gitignore
.dev.vars
.dev.vars.*
.wrangler/
```

`wrangler.toml` `[vars]` holds only non-sensitive config:

```toml
[vars]
NOTION_DB_ID = "abc123..."   # an identifier, not a secret
LOG_LEVEL = "info"
```

### Audit checklist (run once, and before each deploy)

```bash
# 1) No secrets present in tracked files (spot-check common patterns):
git grep -nE "secret_[A-Za-z0-9]|re_[A-Za-z0-9]|-----BEGIN (RSA )?PRIVATE KEY-----" -- . ':!*.md'

# 2) Nothing sensitive ever committed to history:
git log -p -S "secret_" --all | head
git log -p -S "BEGIN PRIVATE KEY" --all | head

# 3) .dev.vars is ignored and NOT tracked:
git check-ignore .dev.vars        # should print ".dev.vars"
git ls-files --error-unmatch .dev.vars   # should error "did not match" (good)

# 4) wrangler.toml [vars] contains no tokens/keys (eyeball + grep):
git grep -nE "TOKEN|KEY|SECRET|PASSWORD" -- wrangler.toml

# 5) Confirm the deployed secrets exist:
wrangler secret list
```

Checklist items to confirm:
- [ ] `NOTION_TOKEN`, `RESEND_API_KEY`, `FCM_SA_JSON` appear in `wrangler secret
      list`, not in `wrangler.toml`.
- [ ] `git grep` (§1/§4 above) returns nothing in tracked non-doc files.
- [ ] `git log -S` shows no historical secret introduction.
- [ ] `.dev.vars` is gitignored and untracked.
- [ ] `[vars]` contains only identifiers/config, no credentials.

### Pitfalls
- **A secret committed once lives in history forever** even after deletion. If
  the audit finds one, rotate the credential immediately — do not merely
  `git rm`.
- Service-account JSON is multi-line; store it as a single secret value
  (wrangler handles the newlines) rather than splitting fields into `[vars]`.

---

## §7 — Observability

### Config

```toml
[observability]
enabled = true
# optional sampling head-room; keep 1.0 (100%) for this low-volume worker
[observability.logs]
head_sampling_rate = 1.0
```

### Structured log helper

```ts
type LogFields = Record<string, unknown>;

/** Emit one structured JSON line. Cheap, greppable, filterable in the dashboard. */
export function logEvent(event: string, fields: LogFields = {}): void {
  // Single-line JSON so `wrangler tail --format json` and log search stay clean.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...fields,
  }));
}
```

Instrument the lifecycle points:

```ts
logEvent("run_start", { trigger: event.cron });
logEvent("sync_done", { processed, deferred });
logEvent("rule_hit", { rule, entityId, threshold });      // every alert rule match
logEvent("alert_send", { rule, entityId, channel, status, latencyMs });
logEvent("run_end", { durationMs, alertsSent, alertsDeduped });
```

### Reading logs with `wrangler tail`

```bash
# Live stream, pretty:
wrangler tail

# JSON stream (machine-parseable), pipe to jq to filter by event/rule/status:
wrangler tail --format json | jq 'select(.event == "alert_send" and .status == "failed")'

# Only rule hits for a specific rule:
wrangler tail --format json | jq 'select(.event=="rule_hit" and .rule=="overdue_task")'

# Server-side filters to cut noise:
wrangler tail --status error
wrangler tail --search "alert_send"
```

Historical queries (beyond the live tail) use the **Workers Logs** view in the
Cloudflare dashboard, filterable on the same JSON fields because every line is
structured.

### Testing / validation
- Run `wrangler tail --format json` in one terminal, trigger a run
  (`wrangler dev` + hit the scheduled handler, or wait for cron), and confirm
  `run_start`, `rule_hit`, `alert_send`, `run_end` all appear with expected
  fields.
- `jq` filter for `status=="failed"` returns rows only when a send truly fails.

### Pitfalls
- **`wrangler tail` samples under high volume** and only shows events *while
  connected* — it is a live debugger, not a historical record. For "what
  happened last night," use Workers Logs / persisted logs, which is why
  structured fields matter.
- Do **not** log secret values or full tokens — log a hash or last-4 if you must
  correlate (`target: token.slice(-6)`).
- Keep each event on one JSON line; multi-line logs break `jq` piping.

---

## §8 — Cron overlap guard (D1 lock row)

### Lock table

```sql
CREATE TABLE IF NOT EXISTS run_lock (
  id           TEXT PRIMARY KEY,     -- constant, e.g. 'pipeline'
  acquired_at  INTEGER NOT NULL,     -- unix seconds
  holder       TEXT                  -- optional: a run UUID for debugging
);
```

### Acquire / check / release

```ts
const LOCK_ID = "pipeline";
const LOCK_TTL_SECONDS = 90;   // > max expected run (60s wall) + margin

/**
 * Try to acquire the lock. Succeeds if no lock exists OR the existing lock is
 * stale (older than TTL). Returns the holder id on success, null if a fresh
 * lock is held by someone else.
 */
export async function acquireLock(env: Env): Promise<string | null> {
  const holder = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const staleBefore = now - LOCK_TTL_SECONDS;

  // Atomic-ish claim in a single statement:
  //  - INSERT if no row exists
  //  - or OVERWRITE if the existing row is stale
  // The WHERE in the ON CONFLICT update makes the takeover conditional.
  const res = await env.DB.prepare(
    `INSERT INTO run_lock (id, acquired_at, holder)
       VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET
       acquired_at = excluded.acquired_at,
       holder      = excluded.holder
     WHERE run_lock.acquired_at < ?4`
  ).bind(LOCK_ID, now, holder, staleBefore).run();

  if ((res.meta.changes ?? 0) === 0) {
    // A fresh lock is held by another run.
    return null;
  }
  return holder;
}

/** Release only if we still hold it (avoid releasing a lock a takeover reclaimed). */
export async function releaseLock(env: Env, holder: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM run_lock WHERE id = ?1 AND holder = ?2`
  ).bind(LOCK_ID, holder).run();
}
```

### Wiring into `scheduled()`

```ts
export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const holder = await acquireLock(env);
    if (!holder) {
      logEvent("run_skipped_locked", {});
      return;   // another fresh run is in progress → do nothing
    }
    const t0 = Date.now();
    try {
      logEvent("run_start", { trigger: event.cron, holder });
      await maybeDailyMaintenance(env, Math.floor(t0 / 1000)); // §1/§2
      await runPipeline(env, ctx);                             // §3/§4/§5
      logEvent("run_end", { durationMs: Date.now() - t0 });
    } catch (err) {
      logEvent("run_error", { error: String(err) });
      throw err;                 // surface to Workers logs / retry policy
    } finally {
      await releaseLock(env, holder);   // always release; TTL covers a crash
    }
  },
};
```

### Testing / validation
- **Overlap blocked:** manually insert a fresh lock (`acquired_at =
  unixepoch('now')`), invoke the handler, confirm it logs `run_skipped_locked`
  and does no work.
- **Stale lock overtaken:** insert a lock with `acquired_at =
  unixepoch('now') - 200` (older than TTL), invoke, confirm the run acquires it
  and proceeds (`changes === 1`).
- **Crash self-heals:** acquire the lock, then simulate a crash (do not release).
  Confirm that after `LOCK_TTL_SECONDS` the next run acquires it.
- **Normal release:** confirm the `run_lock` row is gone after a clean run.

### Pitfalls
- **The lock MUST expire.** A permanent lock + a crashed run = the cron wedged
  forever, silently. The TTL + conditional takeover (`WHERE acquired_at <
  staleBefore`) is the safety valve. Set TTL comfortably above the worst-case run
  time but well within acceptable staleness.
- **Release only your own lock** (`AND holder = ?`) — otherwise a run that
  overtook a stale lock could have *its* lock deleted by the crashed original run
  if it revives.
- D1 does not give true `SELECT ... FOR UPDATE` locking; the single-statement
  conditional upsert above is the pragmatic equivalent and is sufficient for
  cron-granularity (minutes-apart) contention. It is not designed for
  high-frequency concurrent contention.
- Match `LOCK_TTL_SECONDS` to reality: too short and a legitimately long run gets
  overtaken (reintroducing overlap); too long and crash recovery is slow.

---

## Production-readiness checklist

Run this before declaring Phase 7 done.

**Data lifecycle**
- [ ] `alerts_sent.fired_at` populated on every insert; prune runs daily.
- [ ] Recurring rules re-fire next day; not same day; once-ever rules never
      pruned.
- [ ] `device_tokens` deactivated on 404/400 and purged after retention window.
- [ ] `alert_log` grows but is bounded (optional long-horizon prune configured).

**Correctness**
- [ ] Cursor written as `runStart − 120s`; only advanced on successful drain.
- [ ] Boundary-edit test passes (page edited during run seen next run).
- [ ] Duplicate-row / duplicate-alert checks return nothing after double run.

**Resilience**
- [ ] `notionFetchWithRetry` honors `Retry-After`, backs off on 5xx, caps
      attempts.
- [ ] `MAX_PAGES_PER_RUN` enforced; overflow deferred, not dropped.
- [ ] Subrequest count per run verified < Workers cap.

**Delivery integrity**
- [ ] Claim → pending → send → finalize ordering in place.
- [ ] Double-send test passes (retry returns `deduped`, sender called once).
- [ ] Failure-releases-claim policy implemented and documented.

**Security**
- [ ] All secrets via `wrangler secret put`; `wrangler secret list` confirms.
- [ ] `git grep` / `git log -S` audits clean; `.dev.vars` gitignored & untracked.
- [ ] `[vars]` holds only non-sensitive config.

**Observability**
- [ ] `observability.enabled = true`; structured `logEvent` at all lifecycle
      points.
- [ ] `wrangler tail --format json | jq` filters by event/rule/status.
- [ ] No secrets/full tokens in logs.

**Concurrency**
- [ ] `run_lock` acquire/check/release wired into `scheduled()`.
- [ ] Overlap-blocked, stale-overtaken, crash-self-heals, and clean-release tests
      all pass.
- [ ] `LOCK_TTL_SECONDS` tuned above worst-case run, below acceptable staleness.

When every box is checked with evidence, the system is ready for unattended
long-running operation.
