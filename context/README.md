# Notion Ops Dashboard — Context

> **Revised 2026-08-16 — the plan changed.** This is now a **personal,
> single-user** tool. **Email is the only notification channel**; push/FCM and the
> Flutter app (Phase 6) are **deferred**. The dashboard is gated by a
> **password** (Notion OAuth retained as an alternative). The alert rule set was
> rewritten around timer lifecycle, task deadlines, and routine block starts.
>
> **Read [`notion-schema.md`](./notion-schema.md) first.** It is the verified,
> API-captured property reference for the three live databases, and it corrects
> several errors that earlier drafts of this README and `overview.md` were built
> on — including one that would have made routine alerts silently never fire.

This folder is the **source of truth** for building the Notion Ops Dashboard: a single Cloudflare Worker (TanStack Start app) that polls a Notion workspace every minute, detects conditions across Daily Routine / Tasks / Time Tracker (with Transactions / Goals synced for display), emails alerts, and serves a live dashboard. State is persisted in D1.

Each phase has its own folder with three documents:

- **`features.md`** — what the phase delivers, described as user-facing / system-facing capabilities.
- **`goals.md`** — the objectives, exit criteria, and definition of done for the phase.
- **`implementation.md`** — the detailed, step-by-step build guide with code, schema, commands, and pitfalls.

Read the phase's `goals.md` first (what "done" means), then `features.md` (what it does), then `implementation.md` (how to build it).

---

## Architecture

```
Cloudflare Worker (backend)
├── fetch()      → TanStack Start SSR app, password-gated
│                   /login (form) · /login/notion · /auth/callback · /logout
│                   dashboard route loaders (read D1)
└── scheduled()  → cron "* * * * *"
       ├── 1. Snapshot previous timer state (for edge detection)
       ├── 2. Notion pull — incremental for Tasks + Time Tracker,
       │        FULL for Daily Routine (formulas don't bump last_edited_time)
       ├── 3. Normalize pages → rows, upsert into D1
       ├── 4. Run alert rules E1–E9 against the fresh snapshot
       ├── 5. Email un-sent alerts (SMTP or Resend), log to alert_log
       └── 6. Advance sync cursor (with ~2 min overlap)

Bindings: D1 (snapshots + sessions + alert history), KV (login rate limit),
          Secrets (NOTION_TOKEN, SMTP_USER/SMTP_PASS, PASSWORD_HASH, SESSION_SECRET)
```

Both Worker handlers share the same bindings. All alert logic is server-side; the
dashboard is **read-only** (see `notion-schema.md` §6 — the Notion `Start`/`Pause`
buttons cannot be pressed via the API).

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
│   ├── phase-7-hardening/
│   └── phase-8-auth/
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

`apps/mobile/` is the Android app (Phase 6). It receives the same alerts as push
notifications, signs in with the same password against `/api/*`, and lets you
toggle notifications and vibration per device. It needs a `google-services.json`
from your own Firebase project — see `apps/mobile/README.md`.

**Conventions**
- Package manager: `pnpm` workspaces (or npm workspaces) rooted at repo top.
- Secrets never committed: `NOTION_TOKEN`, `SMTP_USER`, `SMTP_PASS` (or `RESEND_API_KEY`), `ALERT_FROM`, `ALERT_TO`, `PASSWORD_HASH`, `SESSION_SECRET` go through `wrangler secret put`; `.dev.vars` for local dev is gitignored.
- **`Notion-Version` pinned to `2025-09-03`**, querying `POST /v1/data_sources/{id}/query`. The classic `2022-06-28` database endpoint **400s on Daily Routine**, which has five data sources. Use one endpoint for all databases.
- All timestamps stored as ISO 8601 **UTC** in D1. Local wall-clock (`Asia/Dhaka`, fixed **+06:00**, no DST) is used only for routine windows, day boundaries, and display.

---

## Notion databases (config)

Query by **data-source ID** on `Notion-Version: 2025-09-03`. Database IDs are kept
for reference and for `GET /v1/databases/{id}`.

| Database | Data-source ID (query this) | Database ID | Env var |
|---|---|---|---|
| Daily Routine Planner | `2bc82224-6217-81a2-9b52-000b6c7526b1` | `2bc82224621781b5b3d1e435e7f9dabf` | `DS_ROUTINE` |
| Tasks | `2c082224-6217-8061-a75e-000b079c1160` | `2c082224621780738f64fe38401f8460` | `DS_TASKS` |
| Time Tracker | `2c182224-6217-80f9-b47a-000b36ded62a` | `2c18222462178014a1cfdff168501bb1` | `DS_TIMER` |
| Transactions | `4aa375e0-4e19-4b48-a639-850786543875` | `cfe3d0b2968f499cbd0774e8f6c4e09f` | `DS_TXN` |
| Goals | `93a3a8d9-ed49-4c95-b0da-39b4c93dadfd` | `be4a4954aa374e57928173258a68f15a` | `DS_GOALS` |

> Daily Routine's database contains **four additional empty data sources** beyond
> the real one. Query the ID above specifically — see `notion-schema.md` §1.

**Property names are exact-match and several contain typos that must be preserved verbatim:** `Day Cateogry`, `Summery`, the status value `Stoped`, and the relation `Project Plans ` (trailing space). Formula / rollup / status fields are **read-only** — read under `.formula` / `.rollup` / `.status`, never write.

**Three traps worth internalising** (full detail in `notion-schema.md`):

1. **Formulas never bump `last_edited_time`.** `Active Now` flipping to Active produces no edit event, so an incremental pull will never see it. Routine triggers are computed **locally** from `Time` + `Days` + timezone.
2. **`Total Time In Seconds` is `0` while a timer runs.** Compute elapsed as `now − Start Time`.
3. **Time Tracker's `Status` groups are miswired** — `Running` sits under "Complete". Filter by option name, never by group. And **Tasks `Status` is dead data**: all 359 rows are `Stoped`.

---

## Build order

```
0 → 1 → 2 → 3 → (4 ∥ 5) → 8 → 7 → 6
```

Phase 4 (alerts) and Phase 5 (dashboard) both read the D1 mirror, so they parallelize once Phase 3 lands. Phase 8 (auth) now runs **before** Phase 7 — the dashboard shouldn't sit on a public URL unguarded while you harden it. Phase 6 (Flutter + FCM) is **deferred**: email covers the notification requirement, and the `Alert` shape already carries everything a push would need if it's revived.

| Phase | Scope | Est. |
|---|---|---|
| 0 | Scaffold + bindings | ½ day |
| 1 | Notion client + normalizers | 1 day |
| 2 | D1 schema | ½ day |
| 3 | Sync engine | 1 day |
| 4 | Alert engine + email (E1–E9) | 1–1.5 days |
| 5 | Dashboard UI + charts | 1.5 days |
| 8 | Auth — password + Notion OAuth | ½–1 day |
| 7 | Hardening | ½–1 day |
| 6 | Flutter app + FCM push | **built** |
| | **Total** | **~6.5–8 days** |

**Notification model (Phase 4):** email only, via **SMTP** (default) or the **Resend HTTP API**, selected with `EMAIL_PROVIDER`. SMTP genuinely works on Workers — Cloudflare blocks outbound port 25 only, while 587/465 connect fine through `cloudflare:sockets`; Nodemailer still does not work, so the protocol is spoken directly. Nine rules: timer started / still-running every 30 min / ended (E1–E3), deadline at 24h / 1h / hit / missed (E4–E7), and routine block start (E8) with an optional daily digest (E9). Expect **~35–45 emails on a typical weekday** and **zero on Fri/Sat** (all Fri/Sat routine rows are archived). Every rule is individually switchable, and `ALERT_QUIET_HOURS` mutes a local window without touching rule code.

**Auth model (Phase 8):** a **password gate** is the primary door — one password stored as a **PBKDF2-SHA256 hash** in a Worker secret, constant-time verified, IP rate-limited via KV. **"Log in with Notion"** is retained as a secondary door, still enforced against a **workspace-ID + email allowlist** (a successful OAuth proves only that the visitor has *a* Notion account — the allowlist is the real control). Both doors issue the same session, so `requireSession`, logout, and expiry are shared. The cron uses the separate **internal** integration and is unaffected by either.
