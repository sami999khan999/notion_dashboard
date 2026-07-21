# Notion Ops Dashboard — Context

This folder is the **source of truth** for building the Notion Ops Dashboard: a single Cloudflare Worker (TanStack Start app) that polls a Notion workspace every minute, detects status conditions across Daily Routine / Tasks / Time Tracker / Transactions / Goals, pushes alerts to a Flutter app via FCM (with optional email), and serves a live dashboard. State is persisted in D1.

Each phase has its own folder with three documents:

- **`features.md`** — what the phase delivers, described as user-facing / system-facing capabilities.
- **`goals.md`** — the objectives, exit criteria, and definition of done for the phase.
- **`implementation.md`** — the detailed, step-by-step build guide with code, schema, commands, and pitfalls.

Read the phase's `goals.md` first (what "done" means), then `features.md` (what it does), then `implementation.md` (how to build it).

---

## Architecture

```
Cloudflare Worker (backend)
├── fetch()      → TanStack Start SSR app + /register route + route loaders (reads D1)
└── scheduled()  → cron "* * * * *"
       ├── 1. Notion incremental pull (last_edited_time cursor)
       ├── 2. Normalize pages → rows, upsert into D1
       ├── 3. Run alert rules against fresh D1 snapshot
       ├── 4. Push un-sent alerts → FCM (→ Flutter app) / email
       └── 5. Advance sync cursor

Flutter app (phone — receive-only)
├── registers FCM device token → POST /register
└── receives pushes (foreground + background), shows notification

Bindings: D1 (state + history + device tokens), KV (alert dedupe / token cache), Secrets (tokens)
```

Both Worker handlers share the same bindings. The Flutter app is a thin client: it registers its push token and displays whatever the Worker sends — all logic stays server-side.

---

## Monorepo layout

The TanStack Start Worker and the Flutter app live in **one git repository**:

```
notion_dashboard/
├── context/                 # this folder — phase specs (source of truth)
│   ├── README.md
│   ├── phase-0-scaffold/
│   ├── phase-1-notion-client/
│   ├── phase-2-d1-schema/
│   ├── phase-3-sync-engine/
│   ├── phase-4-alert-engine/
│   ├── phase-5-dashboard-ui/
│   ├── phase-6-flutter-fcm/
│   └── phase-7-hardening/
├── apps/
│   ├── worker/              # TanStack Start + Cloudflare Worker (backend + dashboard)
│   │   ├── src/
│   │   │   ├── routes/      # TanStack file routes (dashboard + /register + /test-push)
│   │   │   ├── notion/      # client.ts, normalizers, per-DB pulls
│   │   │   ├── sync/        # scheduled() orchestration, upserts, cursor
│   │   │   ├── alerts/      # rule functions + dispatcher + channels (fcm, email)
│   │   │   └── db/          # D1 query helpers
│   │   ├── schema.sql
│   │   ├── wrangler.jsonc
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── mobile/              # Flutter app (receive-only push client)
│       ├── lib/
│       │   ├── main.dart
│       │   └── push.dart
│       ├── android/app/google-services.json   # (gitignored)
│       ├── ios/                                # optional
│       └── pubspec.yaml
├── packages/
│   └── shared/              # (optional) shared TS types: Alert, snapshot row shapes
├── .gitignore              # ignore secrets, service-account JSON, google-services.json, .dev.vars
├── package.json            # workspace root (pnpm/npm workspaces for apps/worker + packages)
└── README.md
```

**Conventions**
- Package manager: `pnpm` workspaces (or npm workspaces) rooted at repo top for the JS side; Flutter is managed by its own `pubspec.yaml` under `apps/mobile`.
- Secrets never committed: `NOTION_TOKEN`, `FCM_SERVICE_ACCOUNT`, `RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO` go through `wrangler secret put`; `.dev.vars` for local dev is gitignored. `google-services.json` and any `.p8` / service-account JSON are gitignored.
- `Notion-Version` header pinned to `2022-06-28` (classic database-query endpoint keyed by 32-char database ID).
- All timestamps stored as ISO 8601 strings (UTC) in D1.

---

## Notion databases (config)

| Database | Database ID (var) | Env var |
|---|---|---|
| Daily Routine Planner | `2bc82224621781b5b3d1e435e7f9dabf` | `DB_ROUTINE` |
| Tasks | `2c082224621780738f64fe38401f8460` | `DB_TASKS` |
| Time Tracker | `2c18222462178014a1cfdff168501bb1` | `DB_TIMER` |
| Transactions | `cfe3d0b2968f499cbd0774e8f6c4e09f` | `DB_TXN` |
| Goals | `be4a4954aa374e57928173258a68f15a` | `DB_GOALS` |

**Property names are exact-match and several contain typos that must be preserved verbatim:** `Day Cateogry`, `Summery`, and the status value `Stoped`. Formula / rollup / status fields (`Active Now`, `Task Progress`, `Total Time In Seconds`, `Status`, `Signed`, `Schedule Status`, `Time Remains`, `Today`) are **read-only** — read under `.formula` / `.rollup` / `.status`, never write.

---

## Build order

```
0 → 1 → 2 → 3 → (4 ∥ 5) → 6 → 7
```

The backend, alerts, and dashboard are fully working before the Flutter app exists. Phase 4 alerts run against a **stub `pushFcm`** that logs to `alert_log`, so every rule can be verified without a phone. Phase 6 swaps the stub for the real FCM sender. Phases 4 (alerts) and 5 (dashboard) both read the D1 mirror, so they parallelize once Phase 3 lands.

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
