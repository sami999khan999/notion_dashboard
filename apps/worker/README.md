# notion-ops

A single Cloudflare Worker that mirrors three Notion databases into D1 every
minute, emails alerts about timers / deadlines / routine blocks, and serves a
password-gated dashboard.

- **Live:** https://notion-ops.prodigycorp.workers.dev
- **Specs:** [`../../context/`](../../context/) — read
  [`notion-schema.md`](../../context/notion-schema.md) before touching Notion code.

## Stack

TanStack Start (SSR on Workers) · D1 · KV · SMTP (or Resend) · FCM push ·
cron `* * * * *`

The Android app in [`../mobile`](../mobile) receives the same alerts as push
notifications and talks to the `/api/*` surface with a bearer token.

`main` is `src/worker.ts`, not the default `@tanstack/react-start/server-entry`,
because we need `scheduled()` alongside `fetch()`.

## Finish the setup

Two things are still needed before it does anything useful.

**1. Set a dashboard password.** Until this is set, nobody can log in (the gate
fails closed, which is the correct default).

```bash
pnpm hash-password 'a long password you choose'
npx wrangler secret put PASSWORD_HASH     # paste the pbkdf2$... output
```

**2. Configure email.** The default provider is **SMTP** (`EMAIL_PROVIDER=smtp`
in `wrangler.jsonc`). For Gmail you need 2-Step Verification on, then an **App
Password** from https://myaccount.google.com/apppasswords — your normal Google
password will not work.

```bash
npx wrangler secret put SMTP_USER    # you@gmail.com
npx wrangler secret put SMTP_PASS    # the 16-char App Password
npx wrangler secret put ALERT_FROM   # Notion Ops <you@gmail.com>
npx wrangler secret put ALERT_TO     # your inbox
```

`SMTP_HOST` / `SMTP_PORT` are vars in `wrangler.jsonc`, defaulting to
`smtp.gmail.com:587`. Port 465 is auto-detected as implicit TLS; anything else
uses STARTTLS.

<details>
<summary>Using Resend instead</summary>

Set `"EMAIL_PROVIDER": "resend"` in `wrangler.jsonc`, then:

```bash
npx wrangler secret put RESEND_API_KEY   # re_...
npx wrangler secret put ALERT_FROM       # Notion Ops <onboarding@resend.dev>
npx wrangler secret put ALERT_TO         # your inbox
```

On the free tier `onboarding@resend.dev` works as a From with no domain setup,
but only delivers to the address that owns the Resend account.
</details>

Until the provider's secrets are all set, the dispatcher logs
`alerts.channel_unconfigured` and **does not consume dedupe keys**, so nothing is
lost — alerts start flowing on the first tick after you set them.

**3. Verify.** Log in and click **Test email** in the dashboard header (or
`POST /test-email` with your session cookie). It sends one message and shows the
provider's actual error text on failure, which is the whole diagnostic when
credentials are wrong.

## Tuning alerts without a redeploy

`/settings` edits the rule config at runtime. The vars in `wrangler.jsonc` stay
the **defaults**; a row in the `settings` table overrides one, and the change
lands on the next cron tick. "Reset to deployed defaults" just deletes the
overrides, so a fresh database behaves exactly like the deployed config.

Values are re-validated and clamped **on read as well as on write**, so a
hand-edited D1 row cannot put a nonsense interval into the alert engine. Fields
you have changed are badged `custom` in the UI.

Quickest lever if 20 routine emails a day is too many: turn **E8** off and **E9**
on — 20 emails become 1 digest.

Already set: `NOTION_TOKEN`, `SESSION_SECRET`.

## Running locally

Local dev is fully self-contained: its own D1 database, its own session secret,
its own password. Nothing you do locally can touch production.

```bash
cd apps/worker
pnpm install
pnpm db:local          # create the tables in the local (miniflare) D1
pnpm dev               # http://localhost:3000 (picks the next free port if taken)
```

Secrets come from **`.dev.vars`** (gitignored). Copy the template and fill it in:

```bash
cp .dev.vars.example .dev.vars
pnpm hash-password --stdin     # paste the pbkdf2$... line into PASSWORD_HASH
```

`.dev.vars` is already set up with a working local login:

| | |
| --- | --- |
| URL | http://localhost:3000 |
| Password | `local-dev-only-password` |

Change it any time with `pnpm hash-password --stdin` and paste the result into
`PASSWORD_HASH` in `.dev.vars`. **Keep `SESSION_SECRET` different from
production** — the template generates its own, so a local cookie can never be
replayed against the deployed Worker.

### Filling the local database

`vite dev` does not fire cron triggers, so a fresh local D1 stays empty. Trigger
one sync+alert pass by hand (dev-only route, 404s when `ENVIRONMENT !== "development"`):

```bash
curl -X POST http://localhost:3000/dev/sync -b cookies.txt
```

The first run backfills everything (359 tasks, 163 timers, 183 routine rows,
~4s); subsequent runs go incremental. Or click through the UI after logging in.

### Local email

Leave `SMTP_USER` / `SMTP_PASS` blank and the alert engine runs normally but
sends nothing — it logs `alerts.channel_unconfigured` and **consumes no dedupe
keys**, so you can exercise the rules without burning alerts or emailing
yourself. Fill them in to test real delivery, then use the **Test email** button.

### Local vs production, at a glance

| | Local | Production |
| --- | --- | --- |
| D1 | miniflare, on disk | Cloudflare, separate data |
| Secrets | `.dev.vars` | `wrangler secret put` |
| Cron | manual `/dev/sync` | every minute |
| Cookie `Secure` | off (http) | on (https) |
| `/dev/sync` | available | 404 |

The two D1 stores are entirely independent — a session, setting, or alert
created in one does not exist in the other.

## Commands

| | |
|---|---|
| `pnpm dev` | local dev server on :3000 |
| `pnpm test` | rule unit tests (offline, frozen clock) |
| `pnpm test:live` | integration test against the real Notion workspace |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm deploy` | build + deploy |
| `pnpm db:local` / `db:remote` | apply `schema.sql` |
| `npx wrangler tail notion-ops` | live logs |

Local dev reads `.dev.vars` (gitignored); see `.dev.vars.example`.

## Layout

```
src/
├── worker.ts        entry — auth gate + fetch + scheduled
├── config.ts        env shape + coercion (no Workers import → testable)
├── env.ts           live bindings via cloudflare:workers
├── notion/          client (data-source endpoint) + normalizers
├── sync/run.ts      cron pipeline: snapshot → pull → upsert → alert → cursor
├── alerts/
│   ├── time.ts         Asia/Dhaka wall-clock helpers
│   ├── rules/          E1-E3 timer · E4-E7 deadline · E8-E9 routine
│   ├── dispatch.ts     dedupe, quiet hours, send, audit
│   ├── email.ts        provider switch + HTML templates
│   ├── fcm.ts          FCM v1 sender (RS256 JWT via Web Crypto)
│   ├── smtp-message.ts RFC 5322 / MIME builders (pure, tested)
│   └── smtp.ts         SMTP over cloudflare:sockets
├── settings/
│   ├── config.ts    env defaults + override merge + validation (pure, tested)
│   └── store.ts     D1 persistence
├── api/mobile.ts    JSON API for the Flutter app (bearer auth)
├── devices/store.ts push device registry + per-device preferences
├── auth/            cookies · password (PBKDF2) · session · routes
├── dashboard/       server functions reading D1 (data.ts, settings.ts)
└── routes/          TanStack file routes (/ and /settings)
```

## Things that will bite you

These are load-bearing and non-obvious — each one caused a real bug or was one
step away from doing so.

1. **Notion formulas never bump `last_edited_time`.** `Active Now` flipping to
   Active produces no edit event. Any edge trigger built on a formula silently
   never fires. Routine windows are therefore computed locally from `Time` +
   `Days`, and routine is pulled in full every tick rather than incrementally.
2. **`Total Time In Seconds` is `0` while a timer runs.** Compute elapsed as
   `now − Start Time`.
3. **Everything is `Asia/Dhaka` (+06:00, no DST).** Routine `Time` strings are
   bare wall-clock and the Worker runs in UTC. `test/rules.test.ts` has an
   explicit regression guard that fails if the offset stops being applied.
4. **Recurring dedupe keys must contain a date.** E8's threshold is
   `YYYY-MM-DDTHH:MM`. Drop the date and every block fires once, ever.
5. **`INSERT…SELECT` + `ON CONFLICT` needs a `WHERE true`** on the SELECT, or
   SQLite fails with `near "DO": syntax error`.
6. **Time Tracker's `Status` groups are miswired** (`Running` sits under
   *Complete*). Filter by option name, never by group. And **Tasks `Status` is
   dead data** — all 359 rows are `Stoped`.
7. **`Start` / `Pause` on Tasks are `button` properties.** The API can neither
   read nor press them, so the dashboard is read-only by design.
8. **SMTP works on Workers, Nodemailer does not.** Cloudflare blocks outbound
   port **25** only; 587/465 connect fine via `cloudflare:sockets` and
   `startTls()` really upgrades. Nodemailer needs `node:net`/`node:tls`
   internals nodejs_compat lacks, so `smtp.ts` speaks the protocol directly.
9. **Mail headers must be RFC 2047 encoded.** Every alert subject contains
   emoji; raw non-ASCII in a header is illegal and silently mangles. The body is
   base64 so a `.` on its own line cannot terminate `DATA` early.
10. **Alert latency has a ~30-90s floor and it is not fixable.** Notion's
    `last_edited_time` has minute resolution and Cloudflare cron cannot run more
    than once a minute, so a timer started at 12:10:31 is not visible until the
    12:11:30 tick. Measured end-to-end latency is 26s in the best case. What
    *was* fixable: every email used to open its own SMTP connection, so a tick
    with N alerts paid the ~2s handshake N times. Sends are now batched over one
    authenticated session — `alerts.batch` in the logs reports `sendMs` and
    `msPerEmail` so this stays measurable.
11. **workerd caps PBKDF2 at 100,000 iterations.** Node has no such limit, so a
    higher value passes every local test and then fails every real login,
    looking exactly like a wrong password. `MAX_PBKDF2_ITERATIONS` and a
    regression test in `test/password.test.ts` pin this.
12. **PowerShell double quotes interpolate `$`.** A hash like
    `pbkdf2$100000$salt$key` becomes `pbkdf2` + garbage. Use **single quotes**
    in PowerShell, or the interactive `wrangler secret put` prompt.

## Debugging a failed login

The login page returns one generic message by design, so the logs are the only
place the cause is visible:

```bash
npx wrangler tail notion-ops
```

| Log event | Meaning |
| --- | --- |
| `auth.ratelimited` | Locked out — 8 attempts / 15 min per IP. Wait, or delete the `login:<ip>:<bucket>` key from the `FLAGS` KV namespace. |
| `auth.derive_failed` | The runtime rejected the derivation (e.g. iteration count too high). **Not** a wrong password. |
| `auth.failed` + `storedHash.likelyShellExpanded` | The secret was mangled by shell `$` expansion when it was set. |
| `auth.failed` + `storedHash.exceedsRuntimeLimit` | Hash generated above the 100k ceiling; regenerate it. |
| `auth.failed` + `fingerprint` | Compare against `sha256(hash).slice(0,8)` computed locally to confirm the deployed secret is the one you intended. |
| `auth.failed`, everything else sane | Genuinely the wrong password. Check with `pnpm verify-password`. |
