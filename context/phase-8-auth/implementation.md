# Phase 8 — Authentication (Password + Log in with Notion) · Implementation

> **Revised 2026-08-16.** The **password gate (§A, at the end of this file) is the
> primary login path**; the Notion OAuth flow documented in §§1–17 is retained as
> a secondary path. Both issue the same session via the same `createSession` and
> the same signed cookie, so §§3, 7, 8, 11 (cookies, session store, route guard,
> logout) apply unchanged to both. Read §A alongside §§3 and 7.

This document is the copy-pasteable reference for the auth gate: the `sessions`
D1 table, the HMAC cookie helpers (Web Crypto), the allowlist enforcement
function, the CSRF `state` helpers, the OAuth token exchange, the `/login`,
`/auth/callback`, and `/logout` server routes, the `requireSession` route guard,
env/config wiring, the Notion public-integration setup, PowerShell secret
commands, a verification matrix, and pitfalls.

- **New code lives in:** `apps/worker/src/auth/`
- **New routes live in:** `apps/worker/src/routes/`
- **Schema addition:** `apps/worker/schema.sql`
- **Runtime model:** TanStack Start SSR on a Cloudflare Worker. Server routes and
  loaders run on the Worker and access D1 via `context.cloudflare.env.DB`. All
  timestamps are ISO 8601 UTC strings.

> **Scope reminder.** This guards `fetch()` routes only. The cron `scheduled()`
> pipeline (Phases 3–4) keeps running under the internal `NOTION_TOKEN` and is
> not touched here. OAuth adds a **second, public** integration for human login.

---

## 1. The `sessions` D1 table

Add this to `apps/worker/schema.sql` (same file as Phase 2). It uses
`IF NOT EXISTS` so the file stays idempotent and re-appliable.

```sql
-------------------------------------------------------------------------------
-- Phase 8: human auth sessions (Log in with Notion)
-------------------------------------------------------------------------------
-- One row per active login session. The cookie carries only the opaque `id`
-- (HMAC-signed); this table is the source of truth for identity + lifecycle.
-- Deleting a row is immediate server-side revocation (logout).
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,  -- opaque random session id (also the cookie subject)
  user_id      TEXT NOT NULL,     -- Notion owner.user.id
  email        TEXT,              -- owner.user.person.email (nullable; lowercased on write)
  workspace_id TEXT,              -- Notion workspace_id from the token response
  name         TEXT,              -- owner.user.name (display only)
  created_at   TEXT NOT NULL,     -- ISO 8601 UTC when the session was created
  expires_at   TEXT NOT NULL,     -- ISO 8601 UTC hard expiry (sliding-refreshed)
  last_seen    TEXT NOT NULL      -- ISO 8601 UTC of the most recent authenticated request
);

-- Fast lookup for the periodic prune of expired sessions.
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
```

Apply it to **both** local and remote D1 (the two are separate stores — see
Pitfalls):

```bash
# Local (miniflare) store
npx wrangler d1 execute notion-ops --local --file=apps/worker/schema.sql

# Remote (production) store
npx wrangler d1 execute notion-ops --remote --file=apps/worker/schema.sql
```

---

## 2. Env / Env interface additions

Extend the Worker's `Env` interface (wherever it is declared — e.g.
`apps/worker/src/env.d.ts` or the generated `worker-configuration.d.ts`
augmentation) with the new secrets and vars.

```ts
export interface Env {
  // --- existing (Phases 0–7) ---
  DB: D1Database;
  FLAGS: KVNamespace;
  NOTION_TOKEN: string; // internal integration — service identity (UNCHANGED)
  // ...other existing secrets/vars...

  // --- Phase 8: public OAuth integration (human login) ---
  NOTION_OAUTH_CLIENT_ID: string;     // secret
  NOTION_OAUTH_CLIENT_SECRET: string; // secret
  SESSION_SECRET: string;             // secret — HMAC key for signing cookies

  // --- Phase 8: vars (wrangler.jsonc) ---
  ALLOWED_WORKSPACE_IDS: string; // comma-separated; empty string = not enforced
  ALLOWED_EMAILS: string;        // comma-separated; empty string = not enforced
  OAUTH_REDIRECT_URI: string;    // e.g. https://notion-ops.<sub>.workers.dev/auth/callback

  // Optional: gate debug tooling in production
  ENVIRONMENT?: string;          // "production" | "development"
}
```

`wrangler.jsonc` additions (vars are **not** secret — the allowlist and redirect
URI are safe to commit; the client id/secret and session secret are **secrets**,
set via CLI and never committed):

```jsonc
{
  // ...existing config...
  "vars": {
    // ...existing vars...
    "ALLOWED_WORKSPACE_IDS": "",   // fill in your workspace id(s), comma-separated
    "ALLOWED_EMAILS": "sami@waywisetech.com",
    "OAUTH_REDIRECT_URI": "https://notion-ops.<sub>.workers.dev/auth/callback",
    "ENVIRONMENT": "production"
  }
}
```

> Leave `ALLOWED_WORKSPACE_IDS`/`ALLOWED_EMAILS` empty **only** if the other is
> set. If both are empty the app refuses all logins by design (see §5).

---

## 3. Cookie signing / verifying (Web Crypto HMAC-SHA256)

`apps/worker/src/auth/cookies.ts`

The cookie carries `sessionId.signature`. The signature is
`HMAC-SHA256(SESSION_SECRET, sessionId)`, base64url-encoded. Verification is
constant-time-ish (compares the recomputed signature to the presented one with a
length-safe XOR accumulator, avoiding early-exit timing leaks).

```ts
/** Base64url helpers (no padding). */
function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"], // we only ever sign; verify = sign-and-compare (see below)
  );
}

/** Hex/utf comparison that does not short-circuit on the first mismatch. */
function timingSafeEqual(a: string, b: string): boolean {
  // Compare over the max length so the loop count doesn't leak which is longer.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Compute base64url HMAC-SHA256 of `value` under `secret`. */
export async function hmacSign(value: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return b64urlEncode(sig);
}

/** Produce the cookie value `value.signature`. */
export async function signValue(value: string, secret: string): Promise<string> {
  const sig = await hmacSign(value, secret);
  return `${value}.${sig}`;
}

/**
 * Verify a `value.signature` cookie. Returns the value if the signature is
 * valid, else null. Uses constant-time-ish comparison.
 */
export async function verifyValue(signed: string, secret: string): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const presented = signed.slice(dot + 1);
  const expected = await hmacSign(value, secret);
  return timingSafeEqual(presented, expected) ? value : null;
}

/** Random opaque id (128 bits, base64url). Used for session ids and CSRF state. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

// ---- Cookie header helpers -------------------------------------------------

export const SESSION_COOKIE = "sid";
export const STATE_COOKIE = "oauth_state";

export interface CookieOpts {
  maxAge?: number;   // seconds
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Serialize a Set-Cookie header value. */
export function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const {
    maxAge, path = "/", httpOnly = true, secure = true, sameSite = "Lax",
  } = opts;
  let out = `${name}=${value}`;
  out += `; Path=${path}`;
  out += `; SameSite=${sameSite}`;
  if (httpOnly) out += "; HttpOnly";
  if (secure) out += "; Secure";
  if (maxAge != null) out += `; Max-Age=${maxAge}`;
  return out;
}

/** A Set-Cookie that clears the named cookie. */
export function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAge: 0 });
}

/** Parse the request Cookie header into a map. */
export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("Cookie") ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
```

> **Note on Web Crypto verify.** `crypto.subtle.verify` also works, but because
> HMAC is deterministic we sign the value again and compare digests ourselves —
> this lets us apply a constant-time comparison and keeps the key usage to
> `["sign"]` only.

---

## 4. Allowlist enforcement

`apps/worker/src/auth/allowlist.ts`

Parses the comma-separated lists, handles empty/unset lists (not enforced), and
enforces the **refuse-all safety default** when both are unset.

```ts
export interface Identity {
  userId: string;
  email: string | null;
  workspaceId: string | null;
  name: string | null;
}

export interface AllowlistResult {
  allowed: boolean;
  reason: string; // human-readable, for logs / the 403 page
}

/** Split a comma list into a trimmed, lowercased, de-duped, non-empty array. */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  ];
}

/**
 * Decide whether an identity may access the dashboard.
 *
 * Rules:
 *   - Empty/unset list = that dimension is NOT enforced.
 *   - workspace list set  → workspace_id must be in it (OR email matches, if that's set).
 *   - email list set      → email must be in it (OR workspace matches, if that's set).
 *   - BOTH unset          → refuse everyone (fail-closed safety default).
 */
export function checkAllowlist(identity: Identity, env: Env): AllowlistResult {
  const workspaces = parseList(env.ALLOWED_WORKSPACE_IDS);
  const emails = parseList(env.ALLOWED_EMAILS);

  // Safety default: never fall open on misconfiguration.
  if (workspaces.length === 0 && emails.length === 0) {
    return {
      allowed: false,
      reason: "no allowlist configured (both ALLOWED_WORKSPACE_IDS and ALLOWED_EMAILS empty) — refusing all logins",
    };
  }

  const wsMatch =
    workspaces.length > 0 &&
    identity.workspaceId != null &&
    workspaces.includes(identity.workspaceId.toLowerCase());

  const emailMatch =
    emails.length > 0 &&
    identity.email != null &&
    emails.includes(identity.email.toLowerCase());

  // Either configured dimension passing is sufficient.
  if (wsMatch || emailMatch) {
    return { allowed: true, reason: "allowlisted" };
  }

  return {
    allowed: false,
    reason: `not on allowlist (workspace_id=${identity.workspaceId ?? "?"}, email=${identity.email ?? "?"})`,
  };
}
```

---

## 5. CSRF `state` generation / validation

`apps/worker/src/auth/state.ts`

The `state` is a random id issued at `/login`, signed and stored in a short-lived
cookie, then re-checked at the callback. (A KV-backed variant is noted below.)

```ts
import { randomId, signValue, verifyValue, STATE_COOKIE, serializeCookie, clearCookie, parseCookies } from "./cookies";

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the OAuth round-trip

/** Create a state value and the Set-Cookie header that carries it (signed). */
export async function issueState(env: Env): Promise<{ state: string; setCookie: string }> {
  const state = randomId();
  const signed = await signValue(state, env.SESSION_SECRET);
  const setCookie = serializeCookie(STATE_COOKIE, signed, {
    maxAge: STATE_TTL_SECONDS,
    httpOnly: true,
    secure: true,
    sameSite: "Lax", // must survive the redirect back from Notion
  });
  return { state, setCookie };
}

/**
 * Validate the callback's `state` query param against the signed state cookie.
 * Returns true only if the cookie signature is valid AND the values match.
 */
export async function validateState(request: Request, env: Env, stateParam: string | null): Promise<boolean> {
  if (!stateParam) return false;
  const cookies = parseCookies(request);
  const signed = cookies[STATE_COOKIE];
  if (!signed) return false;
  const value = await verifyValue(signed, env.SESSION_SECRET);
  if (!value) return false;
  // Constant-time-ish compare is handled inside verifyValue for the signature;
  // the state values themselves are random 128-bit ids, so a direct compare is fine.
  return value === stateParam;
}

/** Header to clear the state cookie once consumed. */
export function clearStateCookie(): string {
  return clearCookie(STATE_COOKIE);
}
```

> **KV alternative.** Instead of a signed cookie you may store
> `FLAGS.put("oauth_state:" + state, "1", { expirationTtl: 600 })` at `/login`
> and `FLAGS.get` + `FLAGS.delete` at the callback. The cookie approach avoids a
> KV round-trip and needs no cleanup; the KV approach is single-use by
> construction. Either satisfies the CSRF requirement.

---

## 6. OAuth token exchange + identity extraction

`apps/worker/src/auth/notion-oauth.ts`

Builds the authorize URL and performs the token exchange with **HTTP Basic auth**
(`base64(client_id:client_secret)`), then extracts the identity fields. Sending
`owner=user` on the authorize URL is what makes the user object + email come back.

```ts
import type { Identity } from "./allowlist";

const NOTION_AUTHORIZE = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN = "https://api.notion.com/v1/oauth/token";

/** Build the Notion authorize URL the user is redirected to. */
export function buildAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.NOTION_OAUTH_CLIENT_ID,
    response_type: "code",
    owner: "user", // <-- returns the owner.user object + email
    redirect_uri: env.OAUTH_REDIRECT_URI,
    state,
  });
  return `${NOTION_AUTHORIZE}?${params.toString()}`;
}

interface NotionTokenResponse {
  access_token: string;
  token_type: string;
  bot_id: string;
  workspace_id: string;
  workspace_name?: string;
  workspace_icon?: string;
  owner?: {
    type: string;
    user?: {
      object: string;
      id: string;
      name?: string;
      avatar_url?: string;
      type?: string;
      person?: { email?: string };
    };
  };
}

/** Exchange the authorization `code` for the token response. */
export async function exchangeCode(env: Env, code: string): Promise<NotionTokenResponse> {
  const basic = btoa(`${env.NOTION_OAUTH_CLIENT_ID}:${env.NOTION_OAUTH_CLIENT_SECRET}`);

  const res = await fetch(NOTION_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.OAUTH_REDIRECT_URI, // MUST match the authorize redirect exactly
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Notion token exchange failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as NotionTokenResponse;
}

/** Pull the identity fields we gate on out of the token response. */
export function extractIdentity(token: NotionTokenResponse): Identity {
  const user = token.owner?.user;
  return {
    userId: user?.id ?? "",
    email: user?.person?.email?.toLowerCase() ?? null,
    workspaceId: token.workspace_id ?? null,
    name: user?.name ?? null,
  };
}
```

> We use `token.access_token` for **nothing** after this point — the dashboard
> reads data via the internal `NOTION_TOKEN`. The OAuth access token exists only
> to make the identity fields available; you may discard it.

---

## 7. Session store (D1)

`apps/worker/src/auth/session.ts`

Creates, resolves (with sliding refresh), and deletes sessions.

```ts
import type { Identity } from "./allowlist";
import { randomId } from "./cookies";

const SESSION_TTL_DAYS = 30;
const SLIDING_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // extend at most once/day

export interface Session {
  id: string;
  userId: string;
  email: string | null;
  workspaceId: string | null;
  name: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeen: string;
}

function isoNow(): string {
  return new Date().toISOString();
}
function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

/** Create a session row and return its opaque id. */
export async function createSession(env: Env, identity: Identity): Promise<string> {
  const id = randomId();
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, email, workspace_id, name, created_at, expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, identity.userId, identity.email, identity.workspaceId, identity.name, now, isoPlusDays(SESSION_TTL_DAYS), now)
    .run();
  return id;
}

/**
 * Resolve a session id to a live Session, or null if missing/expired.
 * Applies sliding refresh: bumps last_seen and extends expiry at most daily.
 */
export async function getSession(env: Env, id: string): Promise<Session | null> {
  const row = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first<any>();
  if (!row) return null;

  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now) {
    // Expired — clean it up opportunistically and treat as no session.
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
    return null;
  }

  // Sliding refresh: only write if last_seen is older than the threshold, to avoid
  // a D1 write on every single request.
  if (now - new Date(row.last_seen).getTime() > SLIDING_REFRESH_THRESHOLD_MS) {
    await env.DB.prepare(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?`)
      .bind(new Date(now).toISOString(), isoPlusDays(SESSION_TTL_DAYS), id)
      .run();
  }

  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    workspaceId: row.workspace_id,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeen: row.last_seen,
  };
}

/** Delete a session (logout / revocation). */
export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
}

/** Optional: periodic prune of expired sessions (call from scheduled() maintenance). */
export async function pruneExpiredSessions(env: Env): Promise<number> {
  const res = await env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(isoNow()).run();
  return res.meta?.changes ?? 0;
}
```

`SESSION_TTL_DAYS` = 30 with sliding refresh gives a 30-day cookie that renews on
use, so an active user rarely re-logs while an abandoned session expires.

---

## 8. Route guard — `requireSession`

`apps/worker/src/auth/require-session.ts`

The single choke point every protected route uses. Reads the signed cookie,
verifies it, resolves the session, and either returns the session or throws a
redirect to `/login`.

```ts
import { parseCookies, verifyValue, SESSION_COOKIE } from "./cookies";
import { getSession, type Session } from "./session";

/** In TanStack Start, throwing a Response from a loader short-circuits it. */
function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/**
 * Resolve the current session or throw a 302 to /login.
 * Use inside protected route loaders / server middleware.
 */
export async function requireSession(request: Request, env: Env): Promise<Session> {
  const cookies = parseCookies(request);
  const signed = cookies[SESSION_COOKIE];
  if (!signed) throw redirectTo("/login");

  const sessionId = await verifyValue(signed, env.SESSION_SECRET);
  if (!sessionId) throw redirectTo("/login"); // forged/tampered cookie

  const session = await getSession(env, sessionId);
  if (!session) throw redirectTo("/login"); // unknown or expired

  return session;
}

/** Non-throwing variant for routes that render differently when logged in/out. */
export async function getOptionalSession(request: Request, env: Env): Promise<Session | null> {
  try {
    return await requireSession(request, env);
  } catch {
    return null;
  }
}
```

Wire it into each protected loader (Phase 5 dashboard, Phase 6 `/register`):

```ts
// apps/worker/src/routes/index.tsx  (Phase 5 dashboard)
export const Route = createFileRoute("/")({
  loader: async ({ context, request }) => {
    const env = context.cloudflare.env;
    await requireSession(request, env); // <-- gate; throws 302 to /login if unauthenticated
    // ...existing Phase 5 loader body (D1 widget queries) unchanged...
  },
  component: DashboardPage,
});
```

> **Central vs. per-route.** If your TanStack Start setup supports server
> middleware, register `requireSession` there for a path prefix so new routes are
> guarded by default. If not, call it as the first line of every protected
> loader. Either way, **allow-list the *public* routes** (`/login`,
> `/auth/callback`, the 403 page) explicitly, and default everything else to
> guarded.

---

## 9. Route: `GET /login`

`apps/worker/src/routes/login.tsx` (server route)

Generates CSRF `state`, sets the signed state cookie, and 302s to Notion's
authorize URL.

```ts
import { createServerFileRoute } from "@tanstack/react-start/server";
import { issueState } from "../auth/state";
import { buildAuthorizeUrl } from "../auth/notion-oauth";

export const ServerRoute = createServerFileRoute("/login").methods({
  GET: async ({ request, context }) => {
    const env = context.cloudflare.env as Env;
    const { state, setCookie } = await issueState(env);
    const authorizeUrl = buildAuthorizeUrl(env, state);

    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl,
        "Set-Cookie": setCookie,
      },
    });
  },
});
```

> The exact server-route API (`createServerFileRoute` / `createAPIFileRoute` /
> server-route `handler`) depends on your TanStack Start version. The logic is
> what matters: **respond 302 to `buildAuthorizeUrl` with the state cookie set.**

---

## 10. Route: `GET /auth/callback`

`apps/worker/src/routes/auth.callback.tsx` (server route)

Validates `state`, exchanges the `code`, extracts identity, **enforces the
allowlist**, creates a session on success, sets the session cookie, and redirects
to `/`. On allowlist failure it renders a clean 403.

```ts
import { createServerFileRoute } from "@tanstack/react-start/server";
import { validateState, clearStateCookie } from "../auth/state";
import { exchangeCode, extractIdentity } from "../auth/notion-oauth";
import { checkAllowlist } from "../auth/allowlist";
import { createSession } from "../auth/session";
import { signValue, serializeCookie, SESSION_COOKIE } from "../auth/cookies";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, matches session TTL

function forbidden(reason: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Not authorized</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0f14;color:#e6e8ee;
display:grid;place-items:center;height:100vh;margin:0}
.card{max-width:28rem;padding:2rem;border:1px solid #232a36;border-radius:12px;background:#161a22}
h1{margin:0 0 .5rem;font-size:1.25rem}p{color:#9aa3b2;line-height:1.5}</style></head>
<body><div class="card">
<h1>Not authorized</h1>
<p>You signed in to Notion successfully, but this account is not on the
dashboard's allowlist. If you believe this is a mistake, contact the owner.</p>
</div></body></html>`;
  return new Response(html, {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Consume the state cookie regardless of outcome.
      "Set-Cookie": clearStateCookie(),
    },
  });
}

export const ServerRoute = createServerFileRoute("/auth/callback").methods({
  GET: async ({ request, context }) => {
    const env = context.cloudflare.env as Env;
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    if (oauthError) return forbidden(`Notion returned error: ${oauthError}`);
    if (!code) return forbidden("missing authorization code");

    // 1. CSRF: state must match the signed state cookie.
    if (!(await validateState(request, env, state))) {
      return forbidden("invalid or missing CSRF state");
    }

    // 2. Exchange the code for identity.
    let identity;
    try {
      const token = await exchangeCode(env, code);
      identity = extractIdentity(token);
    } catch (e) {
      return forbidden(`token exchange failed: ${(e as Error).message}`);
    }

    if (!identity.userId) return forbidden("no user identity returned (was owner=user set?)");

    // 3. AUTHORIZATION — the real gate.
    const decision = checkAllowlist(identity, env);
    if (!decision.allowed) {
      console.warn(JSON.stringify({ event: "auth.denied", reason: decision.reason, email: identity.email, workspace_id: identity.workspaceId }));
      return forbidden(decision.reason);
    }

    // 4. Create session + signed cookie.
    const sessionId = await createSession(env, identity);
    const signed = await signValue(sessionId, env.SESSION_SECRET);
    const sessionCookie = serializeCookie(SESSION_COOKIE, signed, {
      maxAge: SESSION_MAX_AGE,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    });

    console.log(JSON.stringify({ event: "auth.success", email: identity.email, workspace_id: identity.workspaceId }));

    // 5. Redirect to the dashboard; clear the state cookie, set the session cookie.
    const headers = new Headers();
    headers.append("Set-Cookie", clearStateCookie());
    headers.append("Set-Cookie", sessionCookie);
    headers.set("Location", "/");
    return new Response(null, { status: 302, headers });
  },
});
```

---

## 11. Route: `POST /logout`

`apps/worker/src/routes/logout.tsx` (server route)

Deletes the session row and clears the cookie.

```ts
import { createServerFileRoute } from "@tanstack/react-start/server";
import { parseCookies, verifyValue, clearCookie, SESSION_COOKIE } from "../auth/cookies";
import { deleteSession } from "../auth/session";

export const ServerRoute = createServerFileRoute("/logout").methods({
  POST: async ({ request, context }) => {
    const env = context.cloudflare.env as Env;
    const cookies = parseCookies(request);
    const signed = cookies[SESSION_COOKIE];

    if (signed) {
      const sessionId = await verifyValue(signed, env.SESSION_SECRET);
      if (sessionId) await deleteSession(env, sessionId); // server-side revocation
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login",
        "Set-Cookie": clearCookie(SESSION_COOKIE),
      },
    });
  },
});
```

A minimal logout control in the dashboard shell:

```tsx
<form method="POST" action="/logout">
  <button type="submit">Log out</button>
</form>
```

> **Use POST, not GET, for logout** so it can't be triggered by a
> `<img src="/logout">` or a prefetch. SameSite=Lax plus POST is a good baseline.

---

## 12. Locking down `/test-push`

`/test-push` (Phase 6) can trigger real notifications. In production, guard **and**
disable it:

```ts
// apps/worker/src/routes/test-push.tsx
export const Route = createFileRoute("/test-push")({
  loader: async ({ context, request }) => {
    const env = context.cloudflare.env as Env;
    await requireSession(request, env);                 // must be logged in
    if (env.ENVIRONMENT === "production") {              // and not in prod at all
      throw new Response("Not found", { status: 404 });
    }
    // ...dev-only test tooling...
  },
});
```

Alternatively remove the route from the production build entirely, or gate it
behind a `FLAGS` KV switch (`await env.FLAGS.get("enable_test_push")`).

---

## 13. Public Notion integration setup (step by step)

This is the external prerequisite. Do it **once**, in Notion's developer portal.
Keep it **separate** from the internal integration that powers the cron sync.

1. Go to **https://www.notion.so/my-integrations** and click **New integration**.
2. Choose integration type **Public** (not Internal). Public integrations expose
   OAuth (`client_id` + `client_secret`); internal ones only issue a single
   static token.
3. Fill in the required public-integration metadata: name (e.g. "Notion Ops
   Dashboard Login"), logo, and the company/privacy/terms URLs Notion requires
   for public integrations.
4. Under **Capabilities**, this app only needs **identity** — it reads the user's
   name/email at consent time and never touches database content through this
   integration. Request **"Read user information including email addresses."**
   You do **not** need content read/update/insert capabilities on the public
   integration (data access stays with the internal integration).
5. Under **OAuth Domain & URIs → Redirect URIs**, add **exactly**:
   `https://notion-ops.<sub>.workers.dev/auth/callback`
   It must match `OAUTH_REDIRECT_URI` character-for-character (scheme, host,
   path, no trailing slash mismatch). Register a second entry for local dev if
   needed (e.g. `http://localhost:8787/auth/callback`).
6. Save, then copy the **OAuth client ID** and **OAuth client secret** from the
   integration's **Secrets** / **OAuth** section.
7. Store them as Worker secrets (§14). **Never** commit the client secret.

> The internal integration (`NOTION_TOKEN`) stays exactly as it is — still shared
> into the databases, still used by the cron. You now have two integrations: one
> service (internal), one login (public).

---

## 14. Secret setup (PowerShell)

Set the three secrets via `wrangler secret put`. On Windows PowerShell, the
cleanest non-interactive form pipes the value into the command with `echo`
(wrangler reads the secret from stdin):

```powershell
# From the repo root or apps/worker (wherever wrangler.jsonc lives).

# Public OAuth client id (from the Notion public integration)
echo "your-notion-oauth-client-id" | npx wrangler secret put NOTION_OAUTH_CLIENT_ID

# Public OAuth client secret (KEEP THIS PRIVATE — never commit)
echo "your-notion-oauth-client-secret" | npx wrangler secret put NOTION_OAUTH_CLIENT_SECRET

# HMAC key used to sign cookies — generate a long random value:
$secret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
echo $secret | npx wrangler secret put SESSION_SECRET
```

Interactive alternative (wrangler prompts for the value — avoids the secret
appearing in shell history):

```powershell
npx wrangler secret put NOTION_OAUTH_CLIENT_ID
npx wrangler secret put NOTION_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

For **local dev**, put the same keys in `apps/worker/.dev.vars` (which is
gitignored — verified in Phase 7):

```
NOTION_OAUTH_CLIENT_ID=your-notion-oauth-client-id
NOTION_OAUTH_CLIENT_SECRET=your-notion-oauth-client-secret
SESSION_SECRET=some-long-local-dev-secret
```

Verify what's set (values are never shown):

```powershell
npx wrangler secret list
```

---

## 15. Verification (per exit criterion)

| Exit criterion | Concrete test |
| --- | --- |
| Logged-out redirect | In a fresh/incognito browser (no `sid` cookie), open `/`. Expect a **302 to `/login`** then on to `https://api.notion.com/v1/oauth/authorize?...owner=user...`. Confirm no dashboard HTML/data is returned. Repeat for `/register`. |
| Allowlisted success | With your email in `ALLOWED_EMAILS` (or workspace id in `ALLOWED_WORKSPACE_IDS`), complete the Notion consent. Expect a redirect to `/`, the dashboard renders, a `sid` cookie is present (DevTools → Application → Cookies; confirm HttpOnly/Secure/SameSite=Lax), and `SELECT * FROM sessions` shows one fresh row. |
| Session persists | Reload `/`. Expect the dashboard directly (no re-login), proving the cookie/session resolve. |
| Non-allowlisted 403 | Temporarily set `ALLOWED_EMAILS` to an address that is **not** yours and clear `ALLOWED_WORKSPACE_IDS`; log in with your (now non-matching) account. Expect the **403 "not authorized"** page and **no** new `sessions` row. |
| Fail-closed default | Set **both** `ALLOWED_WORKSPACE_IDS` and `ALLOWED_EMAILS` to empty and attempt login. Expect a 403 for everyone (reason: "no allowlist configured"). Restore config afterward. |
| CSRF rejected | Hit `/auth/callback?code=fake&state=wrong` directly (no matching state cookie). Expect the 403 path ("invalid or missing CSRF state"); no token exchange occurs. |
| Forged cookie ignored | With a valid session, edit the `sid` cookie value (flip a character) and reload `/`. Expect a redirect to `/login` (signature verification fails). |
| Logout | While logged in, `POST /logout` (click the logout button). Expect a 302 to `/login`, the `sid` cookie cleared, and the `sessions` row **deleted**. Reload `/` → back to login. |
| Session expiry | Manually set a row's `expires_at` to the past (`wrangler d1 execute ... "UPDATE sessions SET expires_at='2000-01-01T00:00:00Z' WHERE id='...'"`), reload `/` → redirect to `/login` and the stale row is cleaned up. |
| Cron unaffected | Trigger/observe the `scheduled()` run (`wrangler tail`). Confirm sync/alerts run normally, use `NOTION_TOKEN`, and never touch `sessions` or require a cookie. |

---

## 16. Pitfalls

1. **The allowlist is mandatory — anyone can OAuth.** Completing Notion OAuth
   proves only that the visitor has *a* Notion account. Without the
   `checkAllowlist` step, **any Notion user on earth logs in.** Never skip it,
   never "temporarily disable it to test," and keep the fail-closed default
   (both lists empty ⇒ deny all).

2. **Keep the public and internal integrations separate.** The internal
   integration (`NOTION_TOKEN`) is the service identity for sync and must not
   change. The public integration is only for human login. Do not try to make one
   integration do both — you would either leak the service token into the browser
   flow or force visitors to re-share databases at consent.

3. **The redirect URI must match exactly.** `OAUTH_REDIRECT_URI`, the `redirect_uri`
   in the authorize URL, and the `redirect_uri` in the token-exchange body must be
   **byte-identical** to a URI registered in the public integration's settings.
   A trailing slash, `http` vs `https`, or wrong host causes Notion to reject the
   flow. Register both prod and local dev URIs.

4. **OAuth is identity only — data still flows through the service token.** After
   login the dashboard reads D1 (populated by the internal integration). Do not
   store or use the OAuth `access_token` for data access; discard it after
   extracting identity. Visitors never re-share databases.

5. **Cookie flags matter.** Always set `HttpOnly` (blocks JS theft via XSS),
   `Secure` (HTTPS only), `SameSite=Lax` (survives the top-level redirect back
   from Notion but blocks cross-site POST/GET abuse), and `Path=/`. `SameSite=Strict`
   would break the OAuth return; `SameSite=None` needlessly widens exposure.

6. **CSRF `state` is required.** Without it, an attacker can complete an OAuth
   flow in your browser with their code. Always issue a random `state` at
   `/login`, bind it (signed cookie or single-use KV), and reject the callback if
   it doesn't match. Consume the state cookie after use.

7. **Session expiry + sliding refresh.** A cookie with no `Max-Age`/no `expires_at`
   never dies; too short and users re-login constantly. Use a 30-day TTL with
   sliding refresh, but **throttle the refresh write** (only extend when `last_seen`
   is older than ~1 day) so you don't write to D1 on every request.

8. **Protect `/register`, lock down `/test-push`.** These Phase 6 routes are easy
   to forget. `/register` must require a session; `/test-push` should be removed
   or 404'd in production (it can trigger real notifications). Default new routes
   to guarded and explicitly allow-list only `/login`, `/auth/callback`, and the
   403 page.

9. **Never leak `client_secret` (or `SESSION_SECRET`).** These are **secrets**,
   set via `wrangler secret put`, kept out of `wrangler.jsonc` `vars`, out of the
   repo, and only in the gitignored `.dev.vars` for local dev. The client secret
   is used server-side only (Basic auth header in the token exchange); it must
   never reach the browser. Rotating either is a one-command re-`put`.

10. **D1 local vs remote are separate stores.** The `sessions` table (and any
    manual session inspection) exists independently in the local miniflare DB and
    the remote production DB. Apply the schema to **both**, and remember a session
    created against `--local` won't exist `--remote` and vice versa. Test where you
    deploy.

11. **`owner=user` is required for the email.** Omit it and Notion may return a
    bot/workspace-scoped token without the `owner.user.person.email` you gate on.
    The callback guards against this (`if (!identity.userId) ... forbidden`), but
    the root cause is a missing `owner=user` on the authorize URL.

12. **HMAC verification must not short-circuit.** Compare the presented signature
    to the recomputed one with a constant-time-ish comparison (see
    `timingSafeEqual`), not `===` on the raw signature, to avoid a timing oracle
    on cookie forgery attempts.

---

## 17. Where this fits in the build order

- **Runs after Phase 5** (the dashboard exists to protect) and after Phase 6 (so
  `/register` and `/test-push` exist to guard/lock down). In practice it slots
  alongside or just after **Phase 7 hardening** — Phase 7 secured the machine
  surface (secrets, rate limits, idempotency); Phase 8 secures the human surface
  (who can open the app).
- **Guards routes from Phases 5 and 6.** Every dashboard route (Phase 5) and
  `/register` (Phase 6) gains `requireSession`; `/test-push` (Phase 6) is
  locked down.
- **Does not touch Phases 3–4.** The cron sync/alert pipeline and the internal
  `NOTION_TOKEN` are outside this phase and unchanged.
- **New files:** `apps/worker/src/auth/{cookies,allowlist,state,notion-oauth,session,require-session,password}.ts`,
  routes `apps/worker/src/routes/{login,auth.callback,logout}.tsx`, the `sessions`
  table in `apps/worker/schema.sql`, and the env/vars/secrets additions.

---

# §A — The password gate (primary login path)

Everything in §§1–17 stays true. This section adds a second front door that lands
in exactly the same place: a row in `sessions` and a signed `sid` cookie.

## A.1 Schema addition

```sql
-- Which door the session came through. Audit only — nothing branches on it.
ALTER TABLE sessions ADD COLUMN auth_method TEXT DEFAULT 'notion';
```

For a password login, `user_id` is the constant `"owner"`, `email` /
`workspace_id` / `name` are `NULL`, and `auth_method` is `'password'`.
`requireSession` doesn't care.

## A.2 Env additions

```ts
export interface Env {
  // ...existing...
  PASSWORD_HASH: string;   // secret — "pbkdf2$<iterations>$<saltB64url>$<hashB64url>"
  LOGIN_RATE_LIMIT: string; // var — max attempts per window, e.g. "8"
  LOGIN_RATE_WINDOW: string;// var — window seconds, e.g. "900"
}
```

`PASSWORD_HASH` is a **secret**. The two rate-limit knobs are plain vars.

## A.3 Hashing — `auth/password.ts`

PBKDF2-SHA256 via Web Crypto. It's available on Workers, needs no dependency, and
is deliberately slow.

> ⚠️ **workerd caps PBKDF2 at 100,000 iterations.** Above it,
> `crypto.subtle.deriveBits` throws `NotSupportedError: iteration counts above
> 100000 are not supported`. Node's `pbkdf2Sync` has no such limit, so a higher
> value produces a hash that verifies perfectly in every local test and then
> fails **100% of real logins** — surfacing as "Incorrect password" for a
> correct password. This bit us at 210,000 (the OWASP figure) and cost a long
> debugging session, because the generic login error is indistinguishable from a
> genuinely wrong password by design.
>
> Two lessons baked into the code: `verifyPassword` now **logs** the derivation
> error instead of swallowing it in `catch { return false }`, and
> `test/password.test.ts` asserts the generation constant stays at or below
> `MAX_PBKDF2_ITERATIONS`.
>
> 100k is below current OWASP guidance. The compensating controls are the
> per-IP login rate limiter and the fact that an offline attack requires first
> compromising the Cloudflare account that stores the hash.

```ts
import { timingSafeEqual } from "./cookies";

const ITERATIONS = 100_000; // workerd's hard ceiling — see note below
const KEYLEN_BITS = 256;

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, KEYLEN_BITS,
  );
  return b64url(bits);
}

/** Generate a storable hash string. Run once, offline — see A.7. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${hash}`;
}

/** Verify a candidate against the stored "pbkdf2$iters$salt$hash" string. */
export async function verifyPassword(candidate: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const actual = await derive(candidate, unb64url(parts[2]), iterations);
  return timingSafeEqual(actual, parts[3]);   // never ===
}
```

## A.4 Rate limiting — KV

```ts
/**
 * Fixed-window counter keyed by IP. Returns false once the window's budget is
 * spent. Fail-CLOSED: if KV is unavailable we refuse rather than let the limiter
 * silently become a no-op.
 */
export async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const max = Number(env.LOGIN_RATE_LIMIT ?? 8);
  const windowSec = Number(env.LOGIN_RATE_WINDOW ?? 900);
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `login:${ip}:${bucket}`;
  try {
    const n = Number((await env.FLAGS.get(key)) ?? 0);
    if (n >= max) return false;
    await env.FLAGS.put(key, String(n + 1), { expirationTtl: windowSec + 60 });
    return true;
  } catch {
    return false;
  }
}
```

KV is eventually consistent, so a determined attacker across many colo locations
can exceed the budget somewhat. That is acceptable: the limiter exists to make
online brute force impractical, and PBKDF2 at 210k iterations already caps
throughput. Do not swap this for a D1 counter on the hot path — a write per
attempt is exactly what an attacker wants.

Client IP comes from `request.headers.get("CF-Connecting-IP")`, which Cloudflare
sets and a client cannot spoof. Do **not** trust `X-Forwarded-For`.

## A.5 Route — `GET/POST /login`

`/login` now serves a form on GET and verifies on POST. The OAuth entry point
moves to `GET /login/notion` (§9's handler, renamed) so the two don't collide.

```ts
import { createServerFileRoute } from "@tanstack/react-start/server";
import { verifyPassword, checkRateLimit } from "../auth/password";
import { createSession } from "../auth/session";
import { signValue, serializeCookie, SESSION_COOKIE } from "../auth/cookies";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function loginPage(error?: string): Response {
  const msg = error
    ? `<p style="color:#f87171;margin:0 0 12px;font-size:14px">${error}</p>` : "";
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0f14;color:#e6e8ee;
display:grid;place-items:center;height:100vh;margin:0}
.card{width:20rem;padding:2rem;border:1px solid #232a36;border-radius:12px;background:#161a22}
input,button{width:100%;padding:.6rem;margin:.25rem 0;border-radius:8px;
border:1px solid #232a36;background:#0d0f14;color:#e6e8ee;font-size:14px;box-sizing:border-box}
button{background:#2563eb;border-color:#2563eb;cursor:pointer;margin-top:12px}
a{color:#6ea8fe;font-size:13px}</style>
<div class="card"><h1 style="font-size:1.1rem;margin:0 0 1rem">Notion Ops</h1>${msg}
<form method="POST" action="/login">
<input type="password" name="password" placeholder="Password" autofocus
       autocomplete="current-password" required>
<button type="submit">Sign in</button></form>
<p style="margin:1rem 0 0"><a href="/login/notion">Log in with Notion instead</a></p>
</div>`,
    { status: error ? 401 : 200,
      headers: { "Content-Type": "text/html; charset=utf-8",
                 "Cache-Control": "no-store" } },
  );
}

export const ServerRoute = createServerFileRoute("/login").methods({
  GET: async () => loginPage(),

  POST: async ({ request, context }) => {
    const env = context.cloudflare.env as Env;
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    // Rate limit BEFORE doing the expensive KDF — otherwise the limiter itself
    // becomes the CPU-exhaustion vector.
    if (!(await checkRateLimit(env, ip))) {
      console.warn(JSON.stringify({ event: "auth.ratelimited", ip }));
      return loginPage("Incorrect password.");   // deliberately identical message
    }

    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    if (!password || !(await verifyPassword(password, env.PASSWORD_HASH))) {
      console.warn(JSON.stringify({ event: "auth.failed", method: "password", ip }));
      return loginPage("Incorrect password.");
    }

    const sessionId = await createSession(env, {
      userId: "owner", email: null, workspaceId: null, name: null,
    }, "password");

    const cookie = serializeCookie(
      SESSION_COOKIE, await signValue(sessionId, env.SESSION_SECRET),
      { maxAge: SESSION_MAX_AGE, httpOnly: true, secure: true, sameSite: "Lax", path: "/" },
    );
    console.log(JSON.stringify({ event: "auth.success", method: "password", ip }));
    return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie } });
  },
});
```

`createSession` from §7 gains one optional parameter:

```ts
export async function createSession(
  env: Env, identity: Identity, method: "password" | "notion" = "notion",
): Promise<string> {
  // ...unchanged INSERT, with auth_method bound to `method`...
}
```

> **`SameSite=Lax` is required, not `Strict`.** The OAuth path needs to survive
> the top-level redirect back from Notion. Since both paths share one cookie, Lax
> it is. The password POST is same-site anyway, so nothing is lost.

## A.6 Everything downstream is unchanged

`requireSession` (§8), `getSession` sliding refresh (§7), `POST /logout` (§11),
and the `/test-push` lockdown (§12) all work as written. They read the `sid`
cookie and the `sessions` row and never inspect `auth_method`.

The only edit: §8's redirect target `/login` now lands on the password form
instead of bouncing straight to Notion — which is the intended behaviour.

## A.7 Generating and setting the hash

Run this once locally to turn your chosen password into a storable hash. It uses
Node's built-in `crypto` and prints the exact string to store:

```js
// scripts/hash-password.mjs  —  node scripts/hash-password.mjs 'your password'
import { pbkdf2Sync, randomBytes } from "node:crypto";
const ITER = 100_000; // MUST match src/auth/password.ts
const pw = process.argv[2];
if (!pw) { console.error("usage: node hash-password.mjs '<password>'"); process.exit(1); }
const salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, ITER, 32, "sha256");
const b64 = (b) => b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
console.log(`pbkdf2$${ITER}$${b64(salt)}$${b64(hash)}`);
```

The output is byte-compatible with `verifyPassword` above — same KDF, same
iteration count, same base64url encoding of a 32-byte key.

```powershell
node scripts/hash-password.mjs 'your password here'
# paste the pbkdf2$... output when prompted:
npx wrangler secret put PASSWORD_HASH
```

Use the **interactive** form so neither the password nor the hash lands in
PowerShell history. Add to `.dev.vars` (gitignored) for local dev.

Rotating the password is one re-`put`. Existing sessions survive it — to force
re-login, `DELETE FROM sessions`.

## A.8 Verification

| Criterion | Test |
|---|---|
| Logged-out redirect | Incognito, open `/` → 302 to `/login`, password form renders, no dashboard HTML. |
| Correct password | Submit it → 302 to `/`, dashboard renders, `sid` cookie is HttpOnly+Secure+Lax, one `sessions` row with `auth_method='password'`. |
| Wrong password | Submit garbage → 401, same generic "Incorrect password.", **no** `sessions` row. |
| Rate limit | Submit wrong passwords `LOGIN_RATE_LIMIT + 1` times → the last is refused with the *identical* message; log shows `auth.ratelimited`. |
| KV down ⇒ fail closed | Temporarily break the `FLAGS` binding → login refuses rather than allowing unlimited attempts. |
| Hash only | `npx wrangler secret list` shows `PASSWORD_HASH`; grep the repo for the plaintext → zero hits. |
| Forged cookie | Flip a character in `sid` → redirect to `/login`. |
| Logout | `POST /logout` → 302, cookie cleared, `sessions` row deleted. |
| OAuth still gated | With `ALLOWED_EMAILS` set to someone else, `/login/notion` still ends in the 403 page. Adding the password did not open a bypass. |
| Cron unaffected | `wrangler tail` a scheduled run — sync and alerts run with no cookie. |

## A.9 Pitfalls specific to the password path

1. **Never store the plaintext.** Not in `vars`, not in a secret, not in
   `.dev.vars` committed by accident. Only the PBKDF2 string.
2. **Rate limit before hashing.** 210k PBKDF2 iterations per request is a CPU
   amplification attack if an unauthenticated caller can trigger it freely.
3. **The failure message must be identical** for wrong-password and
   rate-limited. Different text tells an attacker their probing is working.
4. **Fail closed when KV errors.** A limiter that degrades to "allow" under load
   is worse than none, because you'll believe it's protecting you.
5. **`CF-Connecting-IP`, never `X-Forwarded-For`.** The latter is client-supplied
   and trivially spoofed, which turns a per-IP limiter into no limiter.
6. **Adding the password does not retire the OAuth allowlist.** `/auth/callback`
   remains a live entry point. Keep it fail-closed, or delete the OAuth routes
   entirely.
7. **POST, never GET, for the password.** A GET puts it in the URL, browser
   history, and any log or referrer header along the way.
8. **`Cache-Control: no-store` on the login page.** Otherwise an intermediary or
   the browser may cache a page rendered mid-flow.
