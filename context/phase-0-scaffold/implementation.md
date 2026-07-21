# Phase 0 — Scaffold · Implementation

> **Audience:** the developer executing Phase 0 on **Windows 11** using
> **PowerShell**. Commands are given for PowerShell; where a command differs from
> POSIX shells it is noted. Copy-paste top to bottom.
>
> **Goal of this doc:** turn an empty folder into a deployed Worker whose empty
> dashboard renders on `*.workers.dev` and whose `scheduled()` logs on the
> `* * * * *` cron.
>
> **Prerequisites:** Node.js LTS (≥ 20), npm, git, and a Cloudflare account.
> Confirm the toolchain first:
>
> ```powershell
> node -v            # v20+ expected
> npm -v
> git --version
> npx wrangler --version
> npx wrangler login # opens a browser; authorizes Wrangler against your account
> npx wrangler whoami
> ```

---

## Step 0 — Working directory

The repo root already exists at `E:\draft\notion_dashboard` and contains
`context/`. All commands below assume you start there.

```powershell
Set-Location E:\draft\notion_dashboard
```

---

## Step 1 — Initialize the repo and the workspace root

Create the git repo and the workspace-aware root `package.json`.

```powershell
git init
```

Create the root `package.json`. This declares the workspaces and holds
repo-wide scripts. (npm workspaces shown; pnpm equivalent noted below.)

**`E:\draft\notion_dashboard\package.json`**

```json
{
  "name": "notion-dashboard",
  "private": true,
  "version": "0.0.0",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev": "npm run dev --workspace apps/worker",
    "deploy": "npm run deploy --workspace apps/worker",
    "typecheck": "npm run typecheck --workspace apps/worker"
  },
  "engines": {
    "node": ">=20"
  }
}
```

> **pnpm alternative.** If you prefer pnpm, omit the `"workspaces"` key above and
> instead create `pnpm-workspace.yaml` at the root:
>
> ```yaml
> packages:
>   - "apps/*"
>   - "packages/*"
> ```

Create the directory skeleton. `apps/mobile` and `packages/shared` are just
placeholders in Phase 0.

```powershell
New-Item -ItemType Directory -Force apps, apps\mobile, packages, packages\shared | Out-Null
# Keep empty dirs in git until they are populated later:
New-Item -ItemType File apps\mobile\.gitkeep, packages\shared\.gitkeep | Out-Null
```

> Do **not** create `apps/worker` by hand — the TanStack scaffolder creates it in
> the next step. If the scaffolder insists on an empty target, create it then.

---

## Step 2 — Scaffold TanStack Start into `apps/worker`

Run the TanStack Start creator and choose the **Cloudflare / Vite** path when
prompted. Target the `apps/worker` directory.

```powershell
npm create @tanstack/start@latest apps/worker
```

During the interactive prompts:

- **Deployment target / template:** choose **Cloudflare** (the Cloudflare + Vite
  option). This wires up the Cloudflare Vite plugin and a Wrangler-compatible
  build.
- **Package manager:** match your root choice (npm or pnpm).
- **TypeScript:** yes.

After it finishes, install from the repo root so workspace hoisting is correct:

```powershell
Set-Location E:\draft\notion_dashboard
npm install
```

Confirm the app runs locally via Vite before touching Cloudflare config:

```powershell
npm run dev --workspace apps/worker
# open the printed http://localhost:xxxx and confirm the starter page renders,
# then stop it (Ctrl+C)
```

> If the scaffolder did not add the Cloudflare Vite plugin (some template
> variants), add it and register it in `apps/worker/vite.config.ts`:
>
> ```powershell
> npm install -D @cloudflare/vite-plugin --workspace apps/worker
> ```
>
> ```ts
> // apps/worker/vite.config.ts
> import { defineConfig } from "vite";
> import { cloudflare } from "@cloudflare/vite-plugin";
> import { tanstackStart } from "@tanstack/react-start/plugin/vite";
>
> export default defineConfig({
>   plugins: [
>     cloudflare({ viteEnvironment: { name: "ssr" } }),
>     tanstackStart(),
>   ],
> });
> ```
>
> The exact plugin wiring depends on the template version the scaffolder emits —
> keep whatever it generated and only add the Cloudflare plugin if missing.

---

## Step 3 — Author `wrangler.jsonc`

Create the Wrangler config in **`apps/worker`**. This is the full config for the
whole project; later phases only fill in placeholder ids and add secrets.

**`E:\draft\notion_dashboard\apps\worker\wrangler.jsonc`**

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
    { "binding": "FLAGS", "id": "<optional>" }
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

Field-by-field:

| Field | Value | Why |
| --- | --- | --- |
| `name` | `notion-ops` | The Worker's name; becomes the `*.workers.dev` subdomain. |
| `compatibility_date` | `2026-06-25` | Pins runtime behavior to a known-good date. |
| `compatibility_flags` | `["nodejs_compat"]` | **Required** — enables Node built-ins the app / deps rely on. |
| `main` | `@tanstack/react-start/server-entry` | The Worker entry **must** be the TanStack server entry, not a hand-written file. |
| `observability.enabled` | `true` | Turns on logs so `wrangler tail` / dashboard show output. |
| `triggers.crons` | `["* * * * *"]` | Fires `scheduled()` every minute. |
| `d1_databases[].binding` | `DB` | Runtime handle `env.DB`. `database_id` filled in Step 4. |
| `kv_namespaces[].binding` | `FLAGS` | Runtime handle `env.FLAGS` for dedupe/token cache. |
| `vars` | Notion DB IDs + `FCM_PROJECT_ID` | **Non-secret** config only. Secrets never go here. |

> **Note on the KV binding.** If you have not created the namespace yet (Step 4b)
> and Wrangler rejects the `<optional>` placeholder, either create the namespace
> first and paste the real `id`, or temporarily comment out the entire
> `kv_namespaces` block until it is needed. Do not deploy with a literal
> `<optional>` id.

---

## Step 4 — Create D1 (and KV) and wire the ids

### 4a — D1

```powershell
npx wrangler d1 create notion-ops
```

The command prints a block containing a `database_id`. Copy that UUID into
`wrangler.jsonc`, replacing `<from d1 create>`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "notion-ops", "database_id": "paste-the-uuid-here" }
],
```

Verify it exists:

```powershell
npx wrangler d1 list
npx wrangler d1 execute notion-ops --remote --command "SELECT 1;"
```

> Phase 0 does **not** create tables — schema/migrations are Phase 1. The
> `SELECT 1` is only to prove connectivity.

### 4b — KV namespace `FLAGS`

```powershell
npx wrangler kv namespace create FLAGS
```

Copy the printed `id` into the `kv_namespaces` block, replacing `<optional>`:

```jsonc
"kv_namespaces": [
  { "binding": "FLAGS", "id": "paste-the-kv-id-here" }
],
```

Verify:

```powershell
npx wrangler kv namespace list
```

---

## Step 5 — Enable and confirm `nodejs_compat`

It is already declared in `compatibility_flags` (Step 3). No extra action is
needed beyond keeping it there. You will confirm it took effect in the
verification section (it appears in the `wrangler deploy` output and in the
Cloudflare dashboard under the Worker's Settings → Runtime).

> If you ever see runtime errors like `No such module "node:..."` or
> `process is not defined`, the flag is missing or the `compatibility_date` is too
> old — re-check this step.

---

## Step 6 — Store secrets (`NOTION_TOKEN`) and set up local secrets

### 6a — Production secret

```powershell
npx wrangler secret put NOTION_TOKEN
# Paste the Notion integration token at the prompt (input is hidden), press Enter.
```

Confirm it registered (values are never shown, only names):

```powershell
npx wrangler secret list
```

> **Do not** add `NOTION_TOKEN` to `vars` in `wrangler.jsonc`. Secrets are
> encrypted by Cloudflare and set only through `wrangler secret put`. FCM
> service-account and Resend secrets are added later, the same way.

### 6b — Local secrets via `.dev.vars`

`wrangler dev` does **not** read production secrets. Create a git-ignored
`.dev.vars` file in `apps/worker` for local runs:

**`E:\draft\notion_dashboard\apps\worker\.dev.vars`**

```dotenv
NOTION_TOKEN=secret_your_local_notion_token_here
```

This file is excluded by `.gitignore` (Step 9). Never commit it.

---

## Step 7 — Type the environment (`Env` interface)

Declare every binding/var the Worker receives, so later phases get type-checking
and autocomplete. Put it in a shared types file inside the worker app.

**`E:\draft\notion_dashboard\apps\worker\src\env.ts`**

```ts
/// <reference types="@cloudflare/workers-types" />

/**
 * Runtime bindings & variables handed to the Worker.
 * - Bindings (DB, FLAGS) come from wrangler.jsonc bindings.
 * - DB_* and FCM_PROJECT_ID come from `vars` (non-secret config).
 * - NOTION_TOKEN (and, later, FCM/Resend secrets) come from `wrangler secret put`.
 */
export interface Env {
  // --- Bindings ---
  DB: D1Database;
  FLAGS: KVNamespace;

  // --- Non-secret config (vars) ---
  DB_TASKS: string;
  DB_ROUTINE: string;
  DB_TIMER: string;
  DB_TXN: string;
  DB_GOALS: string;
  FCM_PROJECT_ID: string;

  // --- Secrets (wrangler secret put / .dev.vars) ---
  NOTION_TOKEN: string;
  // Added in later phases:
  // FCM_SERVICE_ACCOUNT_JSON?: string; // Phase 4
  // RESEND_API_KEY?: string;           // Phase 5
}
```

> **Notion API version reminder (used from Phase 2):** every Notion request must
> send the header `Notion-Version: 2022-06-28`. Not needed in Phase 0, but keep it
> in mind — it lives with the `NOTION_TOKEN` usage.

---

## Step 8 — Add a minimal `scheduled()` handler

The TanStack Cloudflare template exports a `fetch` handler (the SSR app) as its
default. Extend the exported handler object to add `scheduled()`. The exact file
is the one referenced by `main` — for the TanStack server entry you wrap/extend
the default export. A minimal, self-contained pattern:

**`E:\draft\notion_dashboard\apps\worker\src\worker.ts`** (or wherever the template
lets you extend the export — see note below)

```ts
import type { Env } from "./env";

export default {
  // fetch() is provided by the TanStack Start server entry (SSR app).
  // In Phase 0 we only need to prove scheduled() fires.

  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    console.log(
      `[scheduled] cron=${event.cron} tick at ${new Date().toISOString()}`,
    );
    // Phase 2+ will do: pull Notion -> upsert D1 -> run alert rules -> push FCM.
    // Phase 0: log only.
  },
} satisfies ExportedHandler<Env>;
```

> **Important — how this composes with the TanStack server entry.** Because
> `main` is `@tanstack/react-start/server-entry`, the framework owns the default
> export's `fetch`. To add `scheduled()` you typically either:
>
> 1. Keep `main` pointed at the TanStack entry and add the cron handler through
>    the template's supported extension point (recent TanStack Start templates
>    provide a server entry file you can augment with `scheduled`), **or**
> 2. Point `main` at your own `src/worker.ts` that **re-exports** the TanStack
>    `fetch` handler and adds `scheduled`, e.g.:
>
>    ```ts
>    import handler from "@tanstack/react-start/server-entry";
>    import type { Env } from "./env";
>
>    export default {
>      fetch: handler.fetch,
>      async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
>        console.log(`[scheduled] cron=${event.cron} @ ${new Date().toISOString()}`);
>      },
>    } satisfies ExportedHandler<Env>;
>    ```
>
> Use whichever the installed template version supports. **Do not** drop the
> TanStack `fetch` — if you do, the dashboard stops rendering. Verify the
> dashboard still renders after adding `scheduled()`.

Generate/refresh binding types (optional but recommended):

```powershell
npx wrangler types
```

Type-check:

```powershell
npm run typecheck --workspace apps/worker
# or: npx tsc --noEmit --project apps/worker
```

---

## Step 9 — `.gitignore`

Protect secrets and generated files. Place at the repo root.

**`E:\draft\notion_dashboard\.gitignore`**

```gitignore
# Dependencies
node_modules/
.pnpm-store/

# Build output
dist/
.output/
.vite/
build/

# Cloudflare / Wrangler local state
.wrangler/
.dev.vars
.dev.vars.*

# Environment / secrets
.env
.env.*
!.env.example

# Firebase / FCM secrets (used in Phase 4/6)
google-services.json
**/google-services.json
service-account*.json
**/serviceAccount*.json
*firebase-adminsdk*.json

# OS / editor cruft
.DS_Store
Thumbs.db
.idea/
.vscode/*
!.vscode/extensions.json

# Flutter (Phase 6) — will be refined then
apps/mobile/.dart_tool/
apps/mobile/build/
apps/mobile/.flutter-plugins*
```

Make the first commit and confirm no secrets are tracked:

```powershell
git add -A
git status                        # confirm .dev.vars and *.json secrets are NOT listed
git commit -m "Phase 0: scaffold monorepo + Cloudflare Worker (TanStack Start)"
```

---

## Step 10 — Deploy

Deploy the Worker from the `apps/worker` directory (or via the root script).

```powershell
# From apps/worker:
Set-Location E:\draft\notion_dashboard\apps\worker
npx wrangler deploy

# Or from the repo root:
Set-Location E:\draft\notion_dashboard
npm run deploy   # -> wrangler deploy in apps/worker
```

The output prints:
- the compatibility flags in effect (look for `nodejs_compat`),
- the bindings (`DB`, `FLAGS`, `vars`),
- the scheduled trigger (`* * * * *`),
- the deployed URL: `https://notion-ops.<your-subdomain>.workers.dev`.

---

## Verification — mapping each exit criterion to a check

| Exit criterion | How to verify (PowerShell) | Pass condition |
| --- | --- | --- |
| Empty dashboard renders on `*.workers.dev` | `Invoke-WebRequest https://notion-ops.<sub>.workers.dev -UseBasicParsing \| Select-Object StatusCode` then open in browser | `200`; SSR HTML paints the empty shell |
| `scheduled()` logs on cron | `npx wrangler tail notion-ops --format pretty` then wait ≤ 60 s | Log line `[scheduled] cron=* * * * * tick ...` appears |
| Force-fire scheduled locally (fast loop) | `npx wrangler dev` then in another terminal: `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` | Local console prints the scheduled log line |
| `nodejs_compat` enabled | Read `wrangler deploy` output / Cloudflare dashboard → Worker → Settings → Runtime | `nodejs_compat` listed |
| `main` points at TanStack entry | Inspect `wrangler.jsonc`; confirm dashboard renders | `main` = `@tanstack/react-start/server-entry` (or a re-export wrapper) and page renders |
| D1 created & bound | `npx wrangler d1 list`; `npx wrangler d1 execute notion-ops --remote --command "SELECT 1;"` | `notion-ops` listed; query returns a row |
| KV created & bound | `npx wrangler kv namespace list` | `FLAGS` namespace present; id in `wrangler.jsonc` |
| Secret set, not in vars | `npx wrangler secret list`; open `wrangler.jsonc` | `NOTION_TOKEN` in secret list; **absent** from `vars` |
| No `<placeholder>` left | Search `wrangler.jsonc` | No `<from d1 create>` / `<optional>` remain |
| Env typed & compiles | `npm run typecheck --workspace apps/worker` | No TS errors |
| Secrets not committed | `git ls-files \| Select-String -Pattern "dev.vars|service-account|google-services"` | No matches |

> **Tip — local `/__scheduled` endpoint:** `wrangler dev` exposes a special
> `GET /__scheduled?cron=<expr>` endpoint that manually invokes `scheduled()`.
> This is the fastest way to iterate on the cron handler without waiting for a
> real tick or deploying.

---

## Pitfalls

1. **`nodejs_compat` is required.** Without the flag (or with too old a
   `compatibility_date`), Node built-ins and many dependencies fail at runtime
   with errors like `No such module "node:buffer"` or `process is not defined`.
   Keep `["nodejs_compat"]` in `compatibility_flags` and the date at
   `2026-06-25` (or newer).

2. **`main` must point at the TanStack server entry.** The correct value is
   `@tanstack/react-start/server-entry`. If you point `main` at a hand-written
   file that doesn't re-export the framework's `fetch`, the Worker deploys but the
   dashboard 500s or returns blank HTML. If you need `scheduled()`, either use the
   template's extension point or a wrapper module that re-exports the TanStack
   `fetch` alongside your `scheduled` — never replace `fetch` outright.

3. **Secrets never go in `vars`.** `vars` in `wrangler.jsonc` is committed to git.
   Put only non-secret config there (the five `DB_*` IDs, `FCM_PROJECT_ID`).
   `NOTION_TOKEN` and all future credentials go through `wrangler secret put`.

4. **`.dev.vars` for local secrets — and it must be git-ignored.** `wrangler dev`
   does not read production secrets; it reads `apps/worker/.dev.vars`. This file
   holds real tokens for local runs, so it **must** be in `.gitignore` (it is).
   Never commit it. Consider committing a `.dev.vars.example` with placeholder
   keys instead.

5. **Don't leave placeholder ids.** `<from d1 create>` and `<optional>` will fail
   or bind to nothing. Paste the real `database_id` and KV `id` (or comment out
   the KV block until Step 4b is done).

6. **Cron may not "fire" the way you expect in `wrangler dev`.** Local dev does
   not run the real minute cron; use the `/__scheduled?cron=...` endpoint to
   trigger it manually, and confirm real scheduling in production via
   `wrangler tail`.

7. **`observability.enabled` must be `true` to see logs.** If `wrangler tail`
   shows nothing, confirm observability is enabled in `wrangler.jsonc` and that
   you deployed after enabling it.

8. **Windows path quoting.** When a path contains spaces, quote it in PowerShell
   (`"C:\Some Path\file"`). The paths in this repo don't, but Wrangler configs
   copied from elsewhere sometimes do.
