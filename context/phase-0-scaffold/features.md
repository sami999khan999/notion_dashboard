# Phase 0 — Scaffold · Features

> **What this document is:** the list of *capabilities* Phase 0 delivers. Each is
> described as a discrete capability, with **what it is**, **why it matters**, and
> **how we verify it exists**. These are foundations — none are user-visible
> product features, but every later phase is built directly on them.

At a glance:

| # | Capability | Runtime surface | Verified by |
| --- | --- | --- | --- |
| 1 | Monorepo skeleton (workspaces) | build-time | `pnpm/npm` resolves all workspaces |
| 2 | Deployable Worker (TanStack SSR) | `fetch()` | dashboard renders on `*.workers.dev` |
| 3 | Cron wired | `scheduled()` | log line appears each minute |
| 4 | D1 database created & bound | both | `DB` binding present at runtime |
| 5 | KV namespace created & bound | both | `FLAGS` binding present at runtime |
| 6 | Secrets pipeline | both | `NOTION_TOKEN` in `secret list`, not in `vars` |
| 7 | Typed environment (`Env`) | build-time | TS compiles; bindings autocomplete |
| 8 | Local dev loop | dev | `wrangler dev` serves + fires cron locally |
| 9 | Secret-safe VCS hygiene | repo | no secret files tracked by git |

---

## 1. Monorepo skeleton (npm/pnpm workspaces)

**What it is.** One git repository holding both the Cloudflare Worker
(`apps/worker`) and the Flutter app (`apps/mobile`, populated in Phase 6), plus an
optional shared TypeScript types package (`packages/shared`), governed by a
workspace-aware root `package.json`.

```
notion_dashboard/
├── context/            # phase specs (this folder)
├── apps/worker/        # TanStack Start + Cloudflare Worker
├── apps/mobile/        # Flutter app (Phase 6)
├── packages/shared/    # optional shared TS types
├── package.json        # workspace root
└── .gitignore
```

**Why it matters.** The backend contract (alert payload shapes, register-route
DTOs, Notion row types) and the mobile client that consumes it evolve together. A
single repo means one PR can change the Worker's `/register` response and the
Flutter code that parses it, with one source of truth for shared types in
`packages/shared`. It also gives us one CI surface, one `.gitignore`, and one
place to reason about secrets.

**Verify.** From the repo root, the package manager lists all workspace packages
(e.g. `npm query .workspace` / `pnpm -r list`) and installs hoist correctly.

---

## 2. Deployable Worker running the TanStack Start SSR app

**What it is.** A single Cloudflare Worker whose `fetch()` handler is the
TanStack Start server entry (`@tanstack/react-start/server-entry`). It
server-renders the dashboard shell and will later serve the `/register` route.
Deployed with `wrangler deploy`, it is reachable at a public `*.workers.dev` URL.

**Why it matters.** This is the app's front door. Proving an *empty* dashboard
renders end-to-end (Vite build → Wrangler bundle → Cloudflare edge → SSR HTML in
a browser) de-risks the single hardest integration in the project: getting
TanStack Start's SSR to run on the Workers runtime. Everything the user ever sees
flows through this handler.

**Verify.** `curl` the deployed URL → HTTP 200 with SSR HTML; open it in a
browser → the empty dashboard shell paints.

---

## 3. Cron wired to `scheduled()`

**What it is.** The `wrangler.jsonc` `triggers.crons` is set to `* * * * *`
(every minute), and the Worker exports a `scheduled()` handler. In Phase 0 that
handler only `console.log`s; from Phase 2 on it becomes the heart of the system
(pull Notion → upsert D1 → run alert rules → push FCM).

**Why it matters.** The dashboard is read-only; all the *work* happens on the
cron. Wiring and observing `scheduled()` now — before there is any logic — means
that when Phase 2 adds the sync, we already trust the trigger fires on schedule
and its logs are visible. It separates "is the cron plumbing correct?" from "is
my sync logic correct?", which are otherwise painful to debug together.

**Verify.** `wrangler tail` on the deployed Worker shows the log line at the top
of each minute; the handler can also be force-fired locally for a fast loop.

---

## 4. D1 database created and bound

**What it is.** A Cloudflare D1 (SQLite) database named `notion-ops`, created via
`wrangler d1 create`, with its real `database_id` wired into `wrangler.jsonc`
under the `DB` binding.

**Why it matters.** D1 is the project's system of record — synced Notion rows,
alert state, and device registrations all live here. Creating and binding it now
means Phase 1 can immediately author the schema and run migrations against a real
database, and Phase 2 can upsert into it, with zero infra setup mid-phase.

**Verify.** `wrangler d1 list` shows `notion-ops`; the deployed Worker's bindings
include `DB`; a trivial `SELECT 1` via `wrangler d1 execute` succeeds.

---

## 5. KV namespace created and bound (`FLAGS`)

**What it is.** A Cloudflare KV namespace bound as `FLAGS`, reserved for
**fire-and-forget dedupe and token caching** — e.g. remembering which alerts were
already sent, or caching a short-lived FCM OAuth access token — never as a
system of record.

**Why it matters.** KV's eventual-consistency and low-latency reads are a good
fit for idempotency keys and cached tokens, keeping that churn out of D1. Binding
it in Phase 0 (even if unused until later) means the binding name and namespace
id are settled early and don't require a redeploy dance later.

**Verify.** `wrangler kv namespace list` shows the namespace; the `FLAGS` binding
appears in the deployed Worker (or is intentionally commented until first use).

---

## 6. Secrets pipeline (`wrangler secret put`)

**What it is.** A clean separation between **non-secret configuration** (the five
`DB_*` Notion database IDs and `FCM_PROJECT_ID`, kept in `vars` in
`wrangler.jsonc`) and **secrets** (`NOTION_TOKEN` now; FCM service-account and
Resend key later), which are set with `wrangler secret put` and stored encrypted
by Cloudflare — never in the repo. Local development mirrors this via a
git-ignored `.dev.vars` file.

**Why it matters.** Leaking a Notion token or a service-account key is a real
incident. Establishing the discipline in Phase 0 — secrets go through
`wrangler secret put` / `.dev.vars`, config goes in `vars`, and `.gitignore`
enforces it — makes every subsequent phase safe by default.

**Verify.** `wrangler secret list` shows `NOTION_TOKEN`; grepping the repo finds
no token value; `vars` in `wrangler.jsonc` contains only non-secret IDs.

---

## 7. Typed environment (`Env` interface)

**What it is.** A TypeScript `Env` interface describing every binding and
variable the Worker receives at runtime: `DB` (D1), `FLAGS` (KV), the five `DB_*`
string vars, `FCM_PROJECT_ID`, and the `NOTION_TOKEN` secret.

**Why it matters.** It turns runtime configuration into compile-time contracts.
Later phases get autocomplete and type-checking on `env.DB`, `env.NOTION_TOKEN`,
etc., and a typo like `env.DB_TASK` fails the build instead of failing silently
at 03:00 on the cron. It is the single place that documents "what the Worker
expects to be handed."

**Verify.** `tsc --noEmit` passes; editor autocompletes `env.` members.

---

## 8. Local development loop (`wrangler dev`)

**What it is.** The ability to run the Worker locally — Vite dev server for the
React app plus `wrangler dev` for the Workers runtime — with local D1/KV emulation
and secrets sourced from `.dev.vars`, including the ability to fire `scheduled()`
on demand without waiting for a real cron tick.

**Why it matters.** A tight local loop is what makes every later phase
productive: you can iterate on the sync and alert logic against a local D1 and
force-fire the cron in seconds, instead of deploying to the edge and waiting a
minute per iteration.

**Verify.** `wrangler dev` serves the dashboard on `localhost`; hitting the local
scheduled-trigger endpoint runs `scheduled()` and prints the log line.

---

## 9. Secret-safe version control hygiene

**What it is.** A `.gitignore` that excludes all sensitive and generated files:
`.dev.vars`, `.env*`, `google-services.json`, the FCM service-account JSON,
`node_modules/`, build output (`dist/`, `.output/`), and Wrangler's local state
(`.wrangler/`).

**Why it matters.** The cheapest way to prevent a secret leak is to make it
impossible to accidentally stage the file. Getting this right in the first commit
means no secret ever enters git history (which is expensive to purge).

**Verify.** `git status` shows none of the protected files as tracked/staged; a
fresh `git add -A` followed by `git status` lists no secret files.
