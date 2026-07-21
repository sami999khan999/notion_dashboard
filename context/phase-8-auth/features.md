# Phase 8 — Authentication (Log in with Notion) · Features

This document catalogs the **capabilities** Phase 8 delivers and, crucially, the
**security model** behind them. It is descriptive (what exists and why each
control matters) rather than procedural (how to build it — see
`implementation.md`).

## The security model (read this first)

Phase 8 gates the dashboard's `fetch()` routes behind human authentication. There
are two independent ideas that are easy to conflate, so pin them down:

```
┌───────────────────────────────────────────────────────────────────────────┐
│  IDENTITY  (who is this?)          AUTHORIZATION  (are they allowed in?)     │
│  ─────────────────────────         ────────────────────────────────────     │
│  Notion OAuth "Log in with          Allowlist check against configured        │
│  Notion" (owner=user).              ALLOWED_WORKSPACE_IDS + ALLOWED_EMAILS.   │
│  Proves: this is a real Notion      Proves: this specific person is one       │
│  account with a known               WE decided may see the dashboard.         │
│  workspace_id / user.id / email.    ← THIS is the real security control.      │
└───────────────────────────────────────────────────────────────────────────┘
```

### Why the allowlist is the real control — not OAuth

**Anyone can authorize a public Notion integration.** Notion's OAuth does not
restrict *who* may connect; it is an identity provider open to every Notion user
on the planet. So a successful OAuth round-trip proves only that the visitor has
*a* Notion account — not that they have *your* account or belong in *your*
workspace.

If you stopped at "OAuth succeeded → let them in," you would have built an app
that **any Notion user on earth can log into.** That is not a gate; it is a
turnstile with no attendant.

The gate is the **allowlist**: after OAuth returns the identity, the Worker
checks the person's `workspace_id` against `ALLOWED_WORKSPACE_IDS` and/or their
`email` against `ALLOWED_EMAILS`. Only a match creates a session. Everyone else
gets a 403. **This check is mandatory and is the single most important line of
code in the phase.**

### Why there is no per-database ACL

You might expect "let in whoever has access to the databases." **Notion has no
API to enumerate database membership** — there is no endpoint that returns "the
humans who can see the Tasks DB." So a literal per-database ACL is impossible to
implement against Notion's API.

The enforceable proxy is **workspace membership**: all of the dashboard's
databases live in one workspace, so "is this person in our workspace?" (via
`workspace_id`) is the closest approximation to "does this person have access to
the data?" The optional email allowlist narrows it further to specific people.

### Why public vs. internal integrations are split

| Integration | Purpose | Token | Used by | Changed this phase? |
| --- | --- | --- | --- | --- |
| **Internal** | Service identity — read Notion databases for sync | `NOTION_TOKEN` (single static token) | Cron `scheduled()` (Phases 3–4) | **No — untouched** |
| **Public** (new) | Human identity — "Log in with Notion" | `client_id` + `client_secret` (OAuth) | `fetch()` login routes (this phase) | Created here |

They are kept separate on purpose. Internal integrations issue one fixed token
scoped to explicitly shared databases — perfect for a trusted background service,
and it must not change. Public integrations implement OAuth so *end users* can
identify themselves. Mixing them would either expose the service token to the
browser flow or force every visitor to re-share databases at consent time.
**Crucially, OAuth here is used purely for identity** — after login the dashboard
keeps reading data through the existing internal service token, so **visitors
never re-share any databases during consent.** They authorize the login app;
they grant it nothing over your data.

---

## Capability catalog

### 1. Log in with Notion (OAuth identity)

A "Log in with Notion" flow backed by a **public** Notion integration.

- Hitting a protected route while logged out sends the visitor to `/login`, which
  generates a CSRF `state` and redirects to Notion's authorize URL with
  `owner=user`.
- Notion shows its standard consent screen; on approval it redirects back to
  `/auth/callback?code=...&state=...`.
- The Worker exchanges the `code` for the token response and reads the identity
  fields — `workspace_id`, `owner.user.id`, `owner.user.person.email`.
- `owner=user` is what makes Notion return the **user object and email** (rather
  than only a bot/workspace token), which is exactly what the allowlist needs.

**Failure it prevents:** the URL being world-readable. Without a login step, the
`.workers.dev` address is effectively public; anyone who discovers or guesses it
sees your tasks, finances, and routines.

### 2. Workspace-ID + email allowlist gating

The authorization decision. After identity is known, the Worker checks it against
two comma-separated config lists:

- `ALLOWED_WORKSPACE_IDS` — workspace IDs permitted (the workspace-membership
  proxy).
- `ALLOWED_EMAILS` — specific email addresses permitted (case-insensitive).

Semantics:

| `ALLOWED_WORKSPACE_IDS` | `ALLOWED_EMAILS` | Behavior |
| --- | --- | --- |
| set | unset/empty | Admit iff `workspace_id` is in the list |
| unset/empty | set | Admit iff `email` is in the list |
| set | set | Admit iff `workspace_id` **or** `email` matches (either passes) |
| unset/empty | unset/empty | **Refuse everyone** (fail-closed safety default) |

- An **empty/unset list is not enforced** — it simply doesn't contribute a rule.
- But **at least one list must be set**, or the app denies all logins on
  purpose. It never falls open on misconfiguration.

**Failure it prevents:** any Notion user on earth logging in. This is the control
that turns "a valid Notion account" into "a valid *authorized* account."

### 3. Signed, HttpOnly session cookies

After an allowlisted login the Worker mints a session and returns an opaque,
**HMAC-SHA256-signed** session-id cookie.

- Cookie flags: `HttpOnly` (no JS access → XSS can't steal it), `Secure`
  (HTTPS-only), `SameSite=Lax` (survives the top-level OAuth redirect back from
  Notion while blocking cross-site POSTs), `Path=/`, and a reasonable `Max-Age`
  (e.g. 30 days) with **sliding refresh** (each authenticated request bumps
  `last_seen` / extends expiry).
- The cookie value is `sessionId.signature`; the Worker verifies the signature
  before trusting the ID, so a forged or tampered cookie is rejected.
- The default design is **D1-backed**: a `sessions` table holds the session's
  identity and lifecycle. See §7 for the stateless-JWT alternative and its
  trade-offs.

**Failure it prevents:** cookie forgery and theft. Unsigned cookies could be
minted by anyone; non-HttpOnly cookies could be exfiltrated by injected script.

### 4. CSRF-protected callback

The `/login` → Notion → `/auth/callback` round-trip is protected by a `state`
parameter.

- `/login` generates a random `state`, stashes it (in a short-lived **signed
  cookie** or in KV `FLAGS`), and includes it in the authorize URL.
- `/auth/callback` recomputes/looks up the expected `state` and rejects the
  request unless it matches. A missing, malformed, or mismatched `state` is
  refused before any code exchange happens.

**Failure it prevents:** login CSRF — an attacker tricking your browser into
completing an OAuth flow with *their* code, or replaying a stale callback.

### 5. Route guard for all dashboard + `/register` routes

A single choke point — a middleware or a shared loader helper
`requireSession(request, env)` — is applied to every protected route.

- No cookie, invalid signature, unknown session id, or expired session → redirect
  to `/login`.
- Valid session → the loader receives the resolved session identity and proceeds.
- Applied to **all** Phase 5 dashboard routes **and** the Phase 6 `/register`
  route.

**Failure it prevents:** an unprotected route leaking data. Centralizing the
check means a new route is guarded by wiring in one helper, rather than each route
re-implementing (and occasionally forgetting) auth.

### 6. Logout

`POST /logout` ends the session cleanly.

- Deletes the session row from D1 (server-side revocation — the session is dead
  even if the cookie lingers).
- Clears the cookie (`Max-Age=0`).
- Next request has no valid session → redirect to `/login`.

**Failure it prevents:** a session outliving the user's intent — e.g. on a shared
device. Because the row is deleted server-side, logout is real revocation, not
just a client-side cookie wipe.

### 7. Clean 403 for unauthorized accounts

When OAuth succeeds but the allowlist check fails, the visitor gets a **calm,
explicit 403 "not authorized" page** — not a stack trace, not a redirect loop,
not a blank error.

- No session is created.
- The page states plainly that the account is a valid Notion login but is not on
  the allowlist, so the person understands it is an authorization decision, not a
  bug.

**Failure it prevents:** confusing UX (and information leakage) for rejected
users, and accidental session creation on a rejected login.

### 8. `/test-push` locked down in production

The Phase 6 `/test-push` tooling can trigger real notifications. In production it
is either removed or placed behind the guard **and** disabled (e.g. via a
`FLAGS`/env switch).

**Failure it prevents:** a stranger — or even an allowlisted user — spamming push
notifications through a debug endpoint left open in production.

---

## Session strategy: D1-backed vs. stateless JWT

Two viable designs; the phase recommends the first.

| Aspect | **D1-backed session (recommended)** | Stateless signed JWT |
| --- | --- | --- |
| What the cookie holds | Opaque signed session **id** | Signed claims (user id, email, exp) |
| Server state | One row per session in D1 `sessions` | None |
| Revocation | **Immediate** — delete the row | Hard — token valid until `exp` (needs a denylist to revoke early) |
| Cost per request | One indexed D1 read | No DB read — verify signature only |
| Sliding refresh | Update `last_seen` / `expires_at` in the row | Must re-issue the token |
| Best when | You want real logout/revocation and audit | You want zero DB reads and can tolerate delayed revocation |

The default is **D1-backed with an opaque signed session-id cookie**, because
real logout/revocation and a per-session audit trail matter more here than saving
one indexed read. The JWT approach (HMAC via Web Crypto) is documented in
`implementation.md` as an alternative for the read-cost-sensitive case.

---

## What Phase 8 deliberately does not do

- **No password/username auth, no local accounts.** Identity is delegated to
  Notion entirely.
- **No roles/permissions beyond allow/deny.** Everyone who passes the allowlist
  gets the same full-dashboard access. Role-based access can build on the
  `sessions` table later.
- **No per-database ACL.** As explained above, Notion's API makes this
  impossible; workspace membership + email allowlist is the proxy.
- **No change to the cron/sync path.** `scheduled()` and the internal
  `NOTION_TOKEN` are outside this phase's scope and remain exactly as Phase 7
  left them.
