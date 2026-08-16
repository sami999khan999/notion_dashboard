# Phase 8 — Authentication (Password + Log in with Notion) · Goals

> **Revised 2026-08-16.** This is now a **personal, single-user** dashboard, so a
> **password gate is the primary way in**. Notion OAuth is retained as an
> alternative login path — both routes converge on the same `sessions` table and
> the same signed cookie, so the route guard, session store, and cookie helpers
> are shared and unchanged. See §A of `implementation.md` for the password flow.

## Objective

Put the dashboard behind an identity gate. Today the Cloudflare Worker's
`fetch()` routes — the Phase 5 dashboard and the Phase 6 `/register` /
`/test-push` tooling — are reachable by anyone who knows the URL. This phase
makes them reachable **only by authorized humans**, via two interchangeable
front doors:

- **Password** (primary) — one password, stored only as a **scrypt/PBKDF2 hash**
  in a Worker secret, verified with a constant-time compare and rate-limited
  against brute force.
- **Notion OAuth** (secondary) — "Log in with Notion" for identity, gated by a
  **workspace-ID + email allowlist**.

Either path issues the same session. Everything downstream — `requireSession`,
the `sessions` table, cookie signing, logout — is identical regardless of how
you signed in.

The OAuth mechanism is:

1. A visitor hits any protected route while logged out → they are redirected to
   Notion to authorize a **public** Notion integration (`owner=user`).
2. Notion redirects back with a `code`; the Worker exchanges it for the token
   response, from which it reads the person's `workspace_id`, `user.id`, and
   `person.email`.
3. The Worker checks that identity against a configured allowlist. **Only if it
   matches** does it create a session, set a signed HttpOnly cookie, and let the
   person in. A non-allowlisted account gets a clean 403.

The cron `scheduled()` pipeline (Phases 3–4) is **completely untouched** by this
phase. Sync keeps running under the existing **internal** integration token
(`NOTION_TOKEN`) as the service identity. This phase only adds a **second,
public** integration used purely for *human* login, and only guards the
`fetch()` request path.

**Estimated effort: ½–1 day.** One new D1 table, three small server routes, one
route-guard helper, one HMAC cookie helper, and a handful of config values.
There are no new subsystems and no changes to the sync/alert engines.

---

## What this does and does NOT enforce (read this)

This is the single most important framing for the phase, because it is easy to
believe you have built more security than you actually have.

- **It DOES enforce identity.** After login you know *who* the visitor is: a real
  Notion account, with a verified `workspace_id`, `user.id`, and `email` supplied
  by Notion's OAuth token exchange.
- **It DOES enforce an allowlist.** Access is granted only to accounts whose
  workspace ID and/or email you have explicitly listed. This — not the OAuth
  step — is the actual authorization control.
- **It does NOT enforce a literal per-database ACL.** Notion has **no API to
  enumerate who has access to a given database**. You cannot ask Notion "list the
  humans who can see the Tasks DB." There is simply no endpoint for it.
- **The practical proxy** for "the people who have access to the databases" is
  **Notion workspace membership** — all the dashboard's databases live in one
  workspace — optionally narrowed by an explicit email allowlist. That is the
  closest enforceable approximation, and it is what this phase implements.
- **A successful OAuth is NOT authorization.** *Anyone* with a Notion account can
  authorize a public integration. Completing the OAuth dance proves only that the
  visitor has *a* Notion account — not *your* Notion account. Without the
  allowlist check, **any Notion user on earth could log in.** The allowlist is
  the real gate; OAuth is only the identity provider.

If you remember one thing from this document: **the allowlist is mandatory, and
it — not OAuth — is what keeps strangers out.**

---

## The password gate (primary path)

For a single-user tool the password is the pragmatic front door: no consent
screen, no public integration metadata, no third party in the login path.

**What it enforces:** possession of one shared secret. That is *weaker* than
OAuth — it proves knowledge of a string, not identity. It is appropriate here
precisely because there is exactly one legitimate user and the alternative is a
URL anyone can open.

Non-negotiables:

- **Store a hash, never the password.** `PASSWORD_HASH` holds
  `scrypt`/PBKDF2-SHA256 output plus a salt and iteration count. A plaintext
  `DASHBOARD_PASSWORD` secret is not acceptable — Worker secrets are readable by
  anyone with dashboard access to the account.
- **Constant-time comparison.** Reuse the existing `timingSafeEqual` from
  `cookies.ts`; a `===` on the digest is a timing oracle.
- **Rate limit by IP.** A KV counter with a short TTL. Without it, one password
  with no lockout is brute-forceable at whatever rate the Worker will serve.
- **Generic failure message.** "Incorrect password" and nothing more — no
  distinction between wrong password and rate-limited, no timing difference.
- **POST only.** The password never appears in a URL, a referrer, or a log line.

Both paths share one session model, so **logout, expiry, sliding refresh, and
`requireSession` need no branching.** The `sessions` row records which method was
used (`auth_method`), for the audit trail only.

**Both doors must be locked.** Adding the password does not make the OAuth
allowlist optional — an unguarded `/auth/callback` is a bypass around the
password. If you decide you don't want OAuth at all, delete the routes; do not
leave them in place with the allowlist relaxed.

---

## Exit criteria checklist

The phase is complete when every box can be checked with a reproduced test, not
just belief.

### Gate behavior
- [ ] Visiting **any** dashboard route while logged out redirects to Notion login
      (via `/login` → Notion authorize URL).
- [ ] `/register` (Phase 6) is likewise protected — a logged-out device cannot
      reach it.
- [ ] `/test-push` (Phase 6) is removed or guarded (and disabled) in production.

### Successful login
- [ ] An **allowlisted** Notion account completes OAuth, is redirected back to
      `/auth/callback`, passes the allowlist check, and lands on `/` (the
      dashboard).
- [ ] After login a **signed, HttpOnly, Secure, SameSite=Lax** session cookie is
      present, and a corresponding row exists in the D1 `sessions` table.
- [ ] Subsequent requests with that cookie skip login and render the dashboard
      directly.

### Rejected login
- [ ] A **non-allowlisted** Notion account (valid Notion login, but wrong
      workspace and/or email) is rejected with a clean **403 "not authorized"**
      page and **no** session is created.
- [ ] With **both** `ALLOWED_WORKSPACE_IDS` and `ALLOWED_EMAILS` unset/empty, the
      app **refuses all logins** (safety default) — it never falls open.

### CSRF / integrity
- [ ] The callback rejects a request whose `state` is missing, malformed, or does
      not match the value issued at `/login` (CSRF protection).
- [ ] The session cookie cannot be forged: tampering with the cookie value
      invalidates the signature and is treated as no session.

### Logout & lifecycle
- [ ] `POST /logout` deletes the session row **and** clears the cookie; the user
      is bounced back to `/login` on the next request.
- [ ] An expired session (past `expires_at`) is treated as no session and
      triggers a redirect to login.

### No collateral damage
- [ ] The cron `scheduled()` sync/alert pipeline runs exactly as before — it does
      not depend on any session, uses the internal `NOTION_TOKEN`, and is
      unaffected by the auth code.

---

## Dependencies

| Dependency | From | Why this phase needs it |
| --- | --- | --- |
| Worker + bindings (`DB`, `FLAGS`, secrets, `vars`) | Phase 0 | Runtime, D1 binding for sessions, KV for optional `state`, secret/var plumbing |
| D1 database + `schema.sql` | Phase 2 | The new `sessions` table is added here and applied to local + remote D1 |
| Dashboard `fetch()` routes | Phase 5 | These are the routes the guard protects |
| `/register` (and `/test-push`) routes | Phase 6 | Also brought behind the guard / locked down |
| **A PUBLIC Notion integration** with the redirect URI registered | **New — created in this phase** | Provides `client_id` + `client_secret` and the OAuth authorize/callback endpoints |

**Critical external prerequisite:** a **public** Notion integration must be
created in Notion's developer settings, distinct from the internal integration
that powers the cron sync. Its **redirect URI must be registered exactly** as the
Worker's `/auth/callback` URL, or the token exchange fails. See
`implementation.md` for the step-by-step.

Do not repurpose the internal cron integration for OAuth. Keep the two separate:
**internal = service/data access (unchanged); public = human login (new).**

---

## What this unblocks / hardens

- **Confidentiality of personal data.** The dashboard surfaces tasks, finances,
  routines, and time-tracking. This phase ensures only you (and anyone you
  explicitly allowlist) can see it, instead of it being world-readable to anyone
  with the `.workers.dev` URL.
- **Protects the write-ish tooling.** `/register` writes device tokens and
  `/test-push` can trigger real pushes. Gating them stops strangers from
  registering rogue devices or spamming notifications.
- **Establishes a session/identity primitive.** Any future per-user feature
  (audit "who changed what", multi-user views, role-based access) can build on
  the `sessions` table and `requireSession` helper introduced here.
- **Complements Phase 7 hardening.** Phase 7 secured the *machine* surface
  (secrets, rate limits, idempotency). Phase 8 secures the *human* surface
  (who can open the app). Together they make the deployment safe to leave running
  in public.

---

## Definition of Done

The system is done for Phase 8 when a reasonable operator would be comfortable
leaving the Worker on a public URL. Concretely:

1. **Logged-out means locked out.** No protected route renders any data without a
   valid session; the response is a redirect to Notion login, never the
   dashboard.
2. **Only allowlisted humans get in.** A stranger with a perfectly valid Notion
   account cannot pass the gate; the allowlist rejects them with a 403.
3. **Fail-closed by default.** Misconfiguration (both lists empty) denies
   everyone rather than admitting everyone.
4. **Sessions are tamper-proof and expiring.** Cookies are signed, HttpOnly,
   Secure, SameSite=Lax; forged cookies are ignored; sessions expire and can be
   revoked by deleting the row.
5. **Logout works.** One `POST /logout` removes the session everywhere.
6. **The pipeline is untouched.** Cron sync/alerts run identically to Phase 7.

When all six hold and the exit-criteria checklist is fully green, Phase 8 is
done.
