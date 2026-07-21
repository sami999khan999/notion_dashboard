# Notion Ops Dashboard — Implementation Plan

A single Cloudflare Worker (TanStack Start app) that polls your Notion workspace every minute, detects status conditions across Daily Routine / Tasks / Time Tracker / Transactions, and pushes alerts to a **Flutter app on your phone** (via FCM), with optional email. State is persisted in D1; a live dashboard reads from it.

---

## 0. Architecture recap

```
Cloudflare Worker (backend)
├── fetch()      → TanStack Start SSR app + /register route + route loaders (reads D1)
└── scheduled()  → cron "* * * * *"
       ├── 1. Notion incremental pull (last_edited_time cursor)
       ├── 2. Normalize pages → rows, upsert into D1
       ├── 3. Run alert rules against fresh D1 snapshot
       ├── 4. Push un-sent alerts → FCM (→ Flutter app) / email
       └── 5. Advance sync cursor

Flutter app (your phone — receive-only)
├── registers FCM device token → POST /register
└── receives pushes (foreground + background), shows notification

Bindings: D1 (state + history + device tokens), KV (alert dedupe), Secrets (tokens)
```

Both Worker handlers share the same bindings. The Flutter app is a thin client: it registers its push token and displays whatever the Worker sends — all the logic stays server-side.

---

## 1. Your databases (IDs to hardcode in config)

The public Notion API is queried by database ID (32-char) on the classic endpoint, or by data-source ID on the 2025-09+ endpoint.

| Database | Database ID | Data-source ID |
|---|---|---|
| Daily Routine Planner | `2bc82224621781b5b3d1e435e7f9dabf` | `2bc82224-6217-81a2-9b52-000b6c7526b1` |
| Tasks | `2c082224621780738f64fe38401f8460` | `2c082224-6217-8061-a75e-000b079c1160` |
| Time Tracker | `2c18222462178014a1cfdff168501bb1` | `2c182224-6217-80f9-b47a-000b36ded62a` |
| Transactions | `cfe3d0b2968f499cbd0774e8f6c4e09f` | `4aa375e0-4e19-4b48-a639-850786543875` |
| Goals | `be4a4954aa374e57928173258a68f15a` | `93a3a8d9-ed49-4c95-b0da-39b4c93dadfd` |

**Property names to use verbatim** (Notion is exact-match; several of yours have typos worth preserving):

- Tasks: `Tasks` (title), `Category` (select), `Priority` (multi), `Status` (status → `Running`/`Stoped`), `Deadline` (date), `Date` (date), `Completed` (checkbox), `Archive` (checkbox), `Task Progress` (formula), `Total Time In Seconds Today` (rollup), `Task Time Tracker` / `Daily Routine Relation` (relations)
- Time Tracker: `Name` (title), `Start Time` (date+time), `End Time` (date+time), `Status` (status → `Running`/`Stoped`), `Total Time In Seconds` (formula), `Category` (multi), `Summery` (text — sic), `Tasks Relation`
- Daily Routine: `Activity` (title), `Time` (text), `Date` (date), `Days` (multi), `Day Cateogry` (multi — sic), `Done` (checkbox), `Active Now` (formula → boolean), `Schedule Status` (formula), `Time Remains` (formula), `Today` (formula)
- Transactions: `Name`, `Amount` (number), `Type` (select → `Income`/`Expense`), `Date`, `Category`, `Account`, `Month` (select), `Signed` (formula), `Note`
- Goals: `Name`, `Month` (text, e.g. `2026-07`), `Income Goal` (number), `Expense Goal` (number)

> Formula/rollup/status fields are read-only — you read them under `.formula` / `.rollup` / `.status`, never write them.

---

## 2. What the system does (feature spec grounded in your data)

### Alert rules
| # | Rule | Source DB | Condition | Channel |
|---|---|---|---|---|
| A1 | **Orphan timer** | Time Tracker | `Status = Running` AND `Start Time` older than 3h AND `End Time` empty | Push (high) |
| A2 | **Task overdue** | Tasks | `Deadline < today` AND `Completed = false` AND `Archive = false` | Push |
| A3 | **Deadline soon** | Tasks | `Deadline` within next 24h AND not completed | Push |
| A4 | **Routine block starting** | Daily Routine | `Active Now = true` (edge-triggered, fires once at start) | Push |
| A5 | **Routine missed** | Daily Routine | end-of-day AND `Today = true` AND `Done = false` | Email digest |
| A6 | **Budget threshold** | Transactions + Goals | current-month Σ`Amount` where `Type=Expense` ≥ 80% / 100% of `Expense Goal` | Push + Email |
| A7 | **Focus goal** | Time Tracker | by 21:00, Σ tracked seconds today < daily target | Push |

Each rule is a pure function `(snapshot) → Alert[]`. Dedupe is enforced by a `(rule, entity_id, threshold)` unique key so a rule that stays true for 60 minutes fires once, not 60 times.

Primary channel is **push to your Flutter app** (built in Phase 2). Email is the secondary channel for digests — sent via an HTTP email API (Resend/Postmark/etc.), **not** SMTP/Nodemailer, which can't run on Workers.

### Dashboard widgets
- **Now strip** — current routine activity (`Active Now`), running task + timer, live elapsed seconds.
- **Today** — tasks due today, completed count, total tracked time today.
- **Trends** — tracked time per day (7/30-day bar), time by `Category` (donut). Chart.js.
- **Finance** — this month income vs expense vs `Expense Goal`, spend by `Category`, recent transactions.

---

## 3. Phase-by-phase build

### Phase 0 — Scaffold (½ day)
1. `npm create @tanstack/start@latest` → pick the Cloudflare/Vite path.
2. Add the Cloudflare Vite plugin and Wrangler config (see §4).
3. Verify `nodejs_compat` is on and the app deploys with `wrangler deploy`.
4. `wrangler d1 create notion-ops` → copy the id into `wrangler.jsonc`.
5. Put secrets: `wrangler secret put NOTION_TOKEN` (also email + FCM secrets, §5).

**Exit criteria:** empty dashboard renders on `*.workers.dev`; `scheduled()` logs on cron.

### Phase 1 — Notion client layer (1 day)
Thin typed wrapper per database — one low-level fetch helper, then per-DB query + normalize functions.

```ts
// notion/client.ts
const NOTION = "https://api.notion.com/v1";
const HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

export async function queryDb(env: Env, dbId: string, body: object) {
  const res = await fetch(`${NOTION}/databases/${dbId}/query`, {
    method: "POST", headers: HEADERS(env.NOTION_TOKEN), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}
```

Incremental pull — only pages edited since the last cursor:

```ts
export async function pullTasks(env: Env, since: string) {
  return queryDb(env, env.DB_TASKS, {
    filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
    page_size: 100,
  }); // paginate via next_cursor until has_more === false
}
```

Normalizers flatten Notion's verbose property shapes into rows — one per DB:

```ts
export function normalizeTimer(page: any) {
  const p = page.properties;
  return {
    notion_id: page.id,
    name: p["Name"].title[0]?.plain_text ?? "",
    status: p["Status"].status?.name ?? null,      // "Running" | "Stoped"
    start_time: p["Start Time"].date?.start ?? null,
    end_time: p["End Time"].date?.end ?? p["End Time"].date?.start ?? null,
    total_seconds: p["Total Time In Seconds"].formula?.number ?? 0,
    task_id: p["Tasks Relation"].relation[0]?.id ?? null,
    updated: page.last_edited_time,
  };
}
```

**Exit criteria:** each DB pulls and normalizes to typed rows; unit-test normalizers against one sample page each.

### Phase 2 — D1 schema (½ day)
State mirrors Notion (so the dashboard never waits on Notion) plus alert bookkeeping and device tokens.

```sql
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE task_snapshot (
  notion_id TEXT PRIMARY KEY, title TEXT, status TEXT, deadline TEXT,
  completed INTEGER, archived INTEGER, progress REAL, seconds_today INTEGER, updated TEXT);
CREATE TABLE timer_snapshot (
  notion_id TEXT PRIMARY KEY, name TEXT, task_id TEXT, status TEXT,
  start_time TEXT, end_time TEXT, total_seconds INTEGER, updated TEXT);
CREATE TABLE routine_snapshot (
  notion_id TEXT PRIMARY KEY, activity TEXT, time TEXT, date TEXT,
  active_now INTEGER, done INTEGER, updated TEXT);
CREATE TABLE txn_snapshot (
  notion_id TEXT PRIMARY KEY, name TEXT, amount REAL, type TEXT,
  category TEXT, account TEXT, month TEXT, signed REAL, date TEXT);

CREATE TABLE device_tokens (
  token TEXT PRIMARY KEY, platform TEXT, active INTEGER DEFAULT 1,
  registered_at TEXT, last_seen TEXT);

CREATE TABLE alerts_sent (
  rule TEXT, entity_id TEXT, threshold TEXT, sent_at TEXT,
  PRIMARY KEY (rule, entity_id, threshold));
CREATE TABLE alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule TEXT, entity_id TEXT,
  channel TEXT, message TEXT, status TEXT, sent_at TEXT);
```

Apply: `wrangler d1 execute notion-ops --file=./schema.sql`.

**Exit criteria:** tables exist locally (`--local`) and remote.

### Phase 3 — Sync engine (1 day)
`scheduled()` orchestrates pull → upsert → alert → advance cursor.

```ts
export default {
  async scheduled(_e, env: Env, ctx: ExecutionContext) { ctx.waitUntil(runSync(env)); },
  fetch: startHandler, // TanStack Start
};

async function runSync(env: Env) {
  const since = await getCursor(env, "tasks");
  const tasks = await pullAllPages(env, "tasks", since);
  await upsertTasks(env, tasks.map(normalizeTask));
  // …repeat for timers, routine, txns…
  await runAlertRules(env);                 // Phase 4
  await setCursor(env, "tasks", new Date().toISOString());
}
```

Use D1 batch upserts (`INSERT … ON CONFLICT(notion_id) DO UPDATE`). Incremental sync keeps each run's Notion subrequests in single digits, far under the cap.

**Exit criteria:** a `wrangler dev` cron tick mirrors Notion edits into D1.

### Phase 4 — Alert engine (1–1.5 days)
Rules are pure functions returning candidate alerts; a dispatcher dedupes and sends via the push sender (Phase 6) (and email for digests).

```ts
async function runAlertRules(env: Env) {
  const candidates = [
    ...await ruleOrphanTimer(env),   // A1
    ...await ruleOverdue(env),       // A2
    ...await ruleBudget(env),        // A6
    // …
  ];
  for (const a of candidates) {
    const seen = await env.DB.prepare(
      "SELECT 1 FROM alerts_sent WHERE rule=? AND entity_id=? AND threshold=?"
    ).bind(a.rule, a.entityId, a.threshold).first();
    if (seen) continue;
    if (a.channel === "push")  await pushFcm(env, a.title, a.body, { url: a.notionUrl }); // stub until Phase 6
    if (a.channel === "email") await sendEmail(env, a.title, a.html);
    await recordSent(env, a);
  }
}
```

Email uses an HTTP provider (SMTP won't work on Workers):

```ts
async function sendEmail(env: Env, subject: string, html: string) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO, subject, html }),
  });
}
```

Edge-triggered rules (A4 routine-start) fire only on `false → true` transitions — compare the incoming `active_now` against the stored snapshot *before* upserting.

**Exit criteria:** each rule fires once per condition window; re-running cron doesn't double-send; push lands on the phone.

### Phase 5 — Dashboard UI (1.5 days)
TanStack Start route loaders read D1 through the binding (server-side); client components render, timers tick client-side.

```ts
export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const env = context.cloudflare.env;
    const now = await env.DB.prepare(
      "SELECT * FROM routine_snapshot WHERE active_now=1 LIMIT 1").first();
    const running = await env.DB.prepare(
      "SELECT * FROM timer_snapshot WHERE status='Running' LIMIT 1").first();
    const today = await env.DB.prepare(/* tasks due today, seconds today */).all();
    return { now, running, today };
  },
});
```

Widgets: Now strip, Today list, Chart.js trend + donut (client-only import), Finance panel (group `txn_snapshot` by `month`/`category`, join `Goals`). Invalidate the loader every 30–60s to stay live without websockets.

**Exit criteria:** dashboard reflects a Notion edit within one cron cycle (~1 min).

### Phase 6 — Mobile notification app (Flutter + FCM) (1.5–2 days)
A receive-only Flutter app that registers for push and displays alerts. Its job is: get an FCM device token, hand it to the Worker, and render incoming notifications (foreground and background). All alert *logic* already lives in the Worker (Phase 4) — this phase just gives those alerts somewhere to land.

**2.1 Firebase project (≈1h)**
1. Create a Firebase project → add an **Android app** (package name), download `google-services.json` into `android/app/`.
2. (iOS, optional) add an **iOS app**, download `GoogleService-Info.plist`; requires an Apple Developer account ($99/yr) and an **APNs auth key** (`.p8`) uploaded in Firebase → Cloud Messaging. **Android is free.**
3. Project settings → Service accounts → **Generate private key** → this JSON is what the Worker uses to send. Store it as a Worker secret (§5).

**2.2 Flutter client**
Add `firebase_core`, `firebase_messaging`, `flutter_local_notifications`, `http`.

```dart
Future<void> initPush() async {
  await Firebase.initializeApp();
  final fcm = FirebaseMessaging.instance;
  await fcm.requestPermission();

  final token = await fcm.getToken();                 // this phone's address
  await registerToken(token);                         // POST to Worker /register
  fcm.onTokenRefresh.listen(registerToken);           // tokens rotate

  FirebaseMessaging.onMessage.listen(_showLocal);     // app foreground
  FirebaseMessaging.onBackgroundMessage(_bgHandler);  // app closed/background
}

Future<void> registerToken(String? token) async {
  if (token == null) return;
  await http.post(Uri.parse('$kWorkerUrl/register'),
    headers: {'content-type': 'application/json'},
    body: jsonEncode({'token': token, 'platform': Platform.operatingSystem}));
}
```

Foreground messages don't auto-display — render them with `flutter_local_notifications` in `_showLocal`. The whole app can be a single screen (a log of received alerts) — no other UI needed.

**2.3 Worker side — token registry**
The `/register` route upserts tokens into D1 (already created in the Phase 2 schema):

```sql
CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY, platform TEXT, active INTEGER DEFAULT 1,
  registered_at TEXT, last_seen TEXT
);
```

```ts
// routes/register — server route in the Worker
export async function POST({ request, context }) {
  const { token, platform } = await request.json();
  const env = context.cloudflare.env;
  await env.DB.prepare(
    `INSERT INTO device_tokens (token, platform, active, registered_at, last_seen)
     VALUES (?, ?, 1, datetime('now'), datetime('now'))
     ON CONFLICT(token) DO UPDATE SET active=1, last_seen=datetime('now')`
  ).bind(token, platform).run();
  return new Response("ok");
}
```

**2.4 Worker side — FCM sender**
FCM v1 needs an OAuth2 access token (the old server-key API was removed). Mint a JWT from the service account, sign RS256 with Web Crypto, exchange for a 1-hour token, cache it:

```ts
async function getFcmAccessToken(env: Env): Promise<string> {
  // cache in KV/module scope for ~55 min
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);          // client_email, private_key, ...
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
                  aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const jwt = await signRs256(claim, sa.private_key);       // Web Crypto importKey + sign
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  return (await res.json()).access_token;
}

async function pushFcm(env: Env, title: string, body: string, data: Record<string,string> = {}) {
  const at = await getFcmAccessToken(env);
  const { results } = await env.DB.prepare(
    "SELECT token FROM device_tokens WHERE active=1").all<{token:string}>();
  for (const { token } of results) {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token, notification: { title, body }, data } }),
      });
    if (res.status === 404 || res.status === 400) {         // UNREGISTERED / stale token
      await env.DB.prepare("UPDATE device_tokens SET active=0 WHERE token=?").bind(token).run();
    }
  }
}
```

Add a temporary `GET /test-push` route that calls `pushFcm(env, "Test", "Hello from the Worker")` to verify end-to-end before wiring real alerts.

**Exit criteria:** installing the app registers a token in D1, and hitting `/test-push` shows a notification on the phone **with the app closed**.

Once the sender works, replace the stub `pushFcm` used by the Phase 4 alert engine with this real implementation.

### Phase 7 — Hardening (½–1 day)
- **Dedupe TTL:** prune `alerts_sent` daily so recurring rules re-fire next day.
- **Stale push tokens:** already deactivated on FCM 404/400; periodically purge `active=0`.
- **Incremental correctness:** overlap the cursor by ~2 min to avoid boundary misses.
- **Rate limits:** respect Notion 429 `Retry-After`; cap pages per run.
- **Idempotent sends:** write `alert_log` before the network call so a retry can't double-send.
- **Secrets:** everything token-like via `wrangler secret put`.
- **Observability:** `observability.enabled = true`; log rule hits + send status.

---

## 4. wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "notion-ops",
  "compatibility_date": "2026-06-25",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/react-start/server-entry",
  "observability": { "enabled": true },
  "triggers": { "crons": ["* * * * *"] },
  "d1_databases": [
    { "binding": "DB", "database_name": "notion-ops", "database_id": "<from d1 create>" }
  ],
  "kv_namespaces": [
    { "binding": "FLAGS", "id": "<optional, for hot dedupe / token cache>" }
  ],
  "vars": {
    "DB_TASKS": "2c082224621780738f64fe38401f8460",
    "DB_ROUTINE": "2bc82224621781b5b3d1e435e7f9dabf",
    "DB_TIMER": "2c18222462178014a1cfdff168501bb1",
    "DB_TXN": "cfe3d0b2968f499cbd0774e8f6c4e09f",
    "DB_GOALS": "be4a4954aa374e57928173258a68f15a",
    "FCM_PROJECT_ID": "<your-firebase-project-id>"
  }
}
```

---

## 5. Secrets & integration setup

**Secrets** (via `wrangler secret put`, never in `vars`):
- `NOTION_TOKEN` — Notion internal integration secret
- `FCM_SERVICE_ACCOUNT` — the full service-account JSON (keep the `private_key` newlines as `\n`)
- `RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO` — email channel

**Notion:** create an internal integration → share **each** of the five databases with it (••• → Connections), or queries 404. Match `Notion-Version` to your endpoint.

**Firebase/FCM:** create the project, register the Android (and optional iOS) app, and generate the service-account key for the Worker. iOS additionally needs an Apple Developer account and an APNs `.p8` key in Firebase; Android needs neither.

---

## 6. Effort estimate

| Phase | Scope | Est. |
|---|---|---|
| 0 | Scaffold + bindings | ½ day |
| 1 | Notion client + normalizers | 1 day |
| 2 | D1 schema | ½ day |
| 3 | Sync engine | 1 day |
| 4 | Alert engine + channels | 1–1.5 days |
| 5 | Dashboard UI + charts | 1.5 days |
| 6 | Flutter app + FCM pipeline | 1.5–2 days |
| 7 | Hardening | ½–1 day |
| | **Total** | **~7.5–9 days** |

Build order: 0 → 1 → 2 → 3 → (4 ∥ 5) → 6 → 7. The backend, alerts, and dashboard are fully working before the app exists — Phase 4 alerts run against a stub `pushFcm` that logs to `alert_log`, so you can verify every rule fires correctly without a phone. The Flutter app (Phase 6) is built last and just swaps the stub for the real FCM sender. Alerts (4) and dashboard (5) both read the D1 mirror, so they parallelize once Phase 3 lands.

---

## 7. Known pitfalls specific to this build

- **No SMTP / Nodemailer on Workers** — outbound SMTP sockets aren't supported; email must go through an HTTP API (Resend/Postmark/etc.).
- **FCM v1 needs OAuth2** — the legacy server-key API is gone; mint a JWT from the service account and sign RS256 with Web Crypto, cache the 1-hour token.
- **Service-account key formatting** — the `private_key` in the secret must keep its `\n` newlines or the JWT signing fails.
- **Stale device tokens** — FCM returns 404/UNREGISTERED for uninstalled apps; deactivate them in D1 (handled in `pushFcm`).
- **iOS push isn't free** — needs Apple Developer ($99/yr) + APNs `.p8`; Android is free.
- **Foreground messages don't auto-show** — render them with `flutter_local_notifications`.
- **Formula/rollup/status fields are read-only** — `Active Now`, `Task Progress`, `Total Time…`, `Status`; read, never write.
- **Property typos are real** — `Day Cateogry`, `Summery`, and the `Stoped` status value must match exactly.
- **KV eventual consistency** — keep authoritative state in D1; use KV only for fire-and-forget dedupe/token-cache.
- **Cron overlap** — guard a slow run with a D1 lock row if a run risks exceeding 60s.
