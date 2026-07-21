# Phase 0 — Scaffold · Goals

> **Build order:** `0 → 1 → 2 → 3 → (4 ∥ 5) → 6 → 7`
> **This is the first phase.** Nothing precedes it; everything else depends on it.
> **Estimated effort:** ½ day (≈ 3–4 focused hours, including a first live deploy).

---

## 1. Phase objective

Stand up the **monorepo** and the **Cloudflare project** so that:

1. An **empty dashboard renders** on a public `*.workers.dev` URL, served by a
   single Cloudflare Worker running a **TanStack Start (React) SSR** app.
2. The Worker's **`scheduled()` handler fires on the `* * * * *` cron** and writes a
   log line visible in `wrangler tail` / the Cloudflare dashboard.

Phase 0 delivers **plumbing, not product**. There is deliberately no Notion
sync, no D1 schema, no alert logic, and no mobile app yet. The single measure of
success is: *the two runtime surfaces of the Worker — `fetch()` and
`scheduled()` — are both live in production and observable.* Every later phase
plugs logic into these two entry points; if they are not solid, nothing built on
top of them can be trusted.

This phase also creates the **accounts, bindings, and secret pipeline** that all
later phases consume: the D1 database, the KV namespace, the environment
variables for the five Notion database IDs, and the `NOTION_TOKEN` secret.

---

## 2. Scope

### In scope
- Monorepo skeleton with workspaces (`apps/worker`, `apps/mobile`, `packages/shared`).
- TanStack Start scaffolded into `apps/worker` on the **Cloudflare / Vite** path.
- `wrangler.jsonc` fully authored (name, compatibility, cron trigger, D1 + KV bindings, `vars`).
- `nodejs_compat` compatibility flag enabled and verified.
- D1 database `notion-ops` created; its `database_id` wired into `wrangler.jsonc`.
- KV namespace `FLAGS` created (used later for dedupe / token cache).
- `NOTION_TOKEN` stored as a Wrangler **secret** (not a plaintext `var`).
- A minimal `scheduled()` handler that only `console.log`s.
- A typed `Env` interface describing every binding and var.
- `.gitignore` protecting all secret material.
- First successful `wrangler deploy` to `*.workers.dev`.

### Explicitly out of scope (deferred to later phases)
| Deferred item | Phase that owns it |
| --- | --- |
| D1 table schema / migrations | Phase 1 |
| Notion incremental pull logic | Phase 2 |
| Upsert into D1 | Phase 2 |
| Alert rules engine | Phase 3 |
| FCM push delivery | Phase 4 |
| Resend email (HTTP API, no SMTP) | Phase 5 |
| Flutter mobile app | Phase 6 |
| Hardening / polish | Phase 7 |

---

## 3. Dependencies

**None.** Phase 0 is the root of the build graph.

The only external prerequisites are developer-machine tooling and accounts, not
other project phases:

| Prerequisite | Why | Check |
| --- | --- | --- |
| Node.js LTS (≥ 20) + npm | Run Vite, Wrangler, scaffolder | `node -v`, `npm -v` |
| A Cloudflare account | Deploy target, D1, KV | `wrangler whoami` |
| Wrangler CLI (via `npx`/devDep) | Build, deploy, secrets, D1 | `npx wrangler --version` |
| A Notion integration token | Stored now, used Phase 2 | Notion → Integrations |
| Git | Version control the monorepo | `git --version` |

> The Firebase project ID and FCM service-account, and the Resend API key, are
> **not** required in Phase 0. `FCM_PROJECT_ID` can be a placeholder for now; the
> FCM and email secrets are added in Phases 4/5.

---

## 4. Definition of done (exit criteria checklist)

Copy this checklist into the PR description and tick each item.

- [ ] **Repo initialized** as a git repo with a workspace-aware root `package.json`.
- [ ] **Workspaces resolve**: `apps/worker`, `apps/mobile` (placeholder ok), `packages/shared` are discoverable by the package manager.
- [ ] **TanStack Start app scaffolded** into `apps/worker` on the Cloudflare/Vite path; `npm run dev` (Vite) serves the app locally.
- [ ] **`wrangler.jsonc` present** in `apps/worker` with the exact contents from the plan (name `notion-ops`, `compatibility_date` `2026-06-25`, `nodejs_compat`, cron `* * * * *`, D1 + KV bindings, all `DB_*` vars, `FCM_PROJECT_ID`).
- [ ] **`main` points at** `@tanstack/react-start/server-entry`.
- [ ] **`nodejs_compat` enabled** and confirmed in the deploy output / dashboard.
- [ ] **D1 database `notion-ops` created**; real `database_id` pasted into `wrangler.jsonc` (no `<placeholder>` left).
- [ ] **KV namespace `FLAGS` created**; real `id` pasted in (or binding intentionally left commented until needed).
- [ ] **`NOTION_TOKEN` set as a secret** via `wrangler secret put` (verified present with `wrangler secret list`; **not** in `vars`).
- [ ] **`Env` TypeScript interface** declares `DB`, `FLAGS`, all `DB_*` vars, `FCM_PROJECT_ID`, and `NOTION_TOKEN`.
- [ ] **`scheduled()` handler** exists and `console.log`s a recognizable line.
- [ ] **`wrangler deploy` succeeds** and prints a `*.workers.dev` URL.
- [ ] **Empty dashboard renders** at that URL (HTTP 200, HTML body from SSR).
- [ ] **`scheduled()` logs on cron**: within ~1 minute, `wrangler tail` shows the scheduled log line (also triggerable on demand — see implementation).
- [ ] **`.gitignore` protects secrets**: `.dev.vars`, `.env*`, `google-services.json`, service-account JSON, `node_modules`, build output, `.wrangler/` are all ignored.
- [ ] **No secret material committed** (verified with `git status` / a grep of the working tree).

When every box is ticked, Phase 0 is **done**.

---

## 5. What this unblocks

Phase 0 is a hard gate for the entire project. Concretely:

- **Phase 1 (D1 schema & migrations)** needs the `DB` binding to exist and the
  Worker to deploy, so it can run migrations against a real database.
- **Phase 2 (Notion sync)** needs the `NOTION_TOKEN` secret, the five `DB_*`
  env vars, the `scheduled()` entry point, and the `DB` binding to write into.
- **Phases 3–5 (alerts, FCM, email)** all extend the same `scheduled()` handler
  and read from the same `Env` bindings created here.
- **Phase 6 (Flutter app)** lives in `apps/mobile`, the workspace directory
  reserved here, and talks to the `/register` route that this scaffold's Worker
  will host.

If the scaffold is shaky (wrong `main` entry, missing `nodejs_compat`, secrets
leaked into `vars`), those defects propagate into every downstream phase. That is
why the exit criteria are strict and the verification section in
`implementation.md` maps each criterion to a concrete check.

---

## 6. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `nodejs_compat` not enabled | Node built-ins fail at runtime in later phases | Enable in `compatibility_flags`; verify in deploy output (exit criterion). |
| `main` not pointing at the TanStack server entry | Worker deploys but SSR route 500s / blank | Use `@tanstack/react-start/server-entry`; verify dashboard renders. |
| Secrets committed to git | Token leak | `.gitignore` + secrets via `wrangler secret put` + `.dev.vars` (git-ignored). |
| D1 `database_id` left as placeholder | Deploy binds to nothing / errors | Exit criterion requires real id pasted in. |
| Cron doesn't fire in dev | False belief that scheduled works | Verify in production via `wrangler tail`, and force-fire locally. |
