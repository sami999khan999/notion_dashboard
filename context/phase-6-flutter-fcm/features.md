# Phase 6 — Mobile Notification App (Flutter + FCM): Features

This document catalogs the **capabilities** delivered by Phase 6. It is deliberately
descriptive (what exists and why) rather than procedural (how to build it — see
`implementation.md`).

## The Architectural Split (read this first)

Phase 6 introduces a mobile app, but it does **not** move any intelligence to the device.
The split is strict and intentional:

```
┌──────────────────────── Cloudflare Worker (server) ────────────────────────┐
│  Phase 3 sync  →  Phase 4 alert engine (thresholds, dedupe, cooldowns)      │
│                        │                                                     │
│                        ▼  calls pushFcm(env, title, body, data)             │
│  Phase 6:  device_tokens registry  +  FCM v1 OAuth2 sender  +  cleanup      │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                 │  FCM HTTP v1  (Google delivers)
                                 ▼
┌──────────────────────── Flutter app (apps/mobile) ─────────────────────────┐
│  Thin, RECEIVE-ONLY client:  get token → register → display notifications   │
│  No thresholds. No polling. No alert logic. Just render what arrives.       │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Why this way:**

- **Single source of truth.** Alert rules already live in the Worker (Phase 4) and touch
  D1 data the phone never sees. Duplicating any of that on-device would create drift and
  double-fire risk.
- **Thin client = cheap to maintain.** No app-store redeploy is needed to change *what*
  alerts fire or *when*. Only the presentation of an already-decided alert lives on-device.
- **Receive-only = minimal attack/permission surface.** The app requests notification
  permission and network access to POST a token — nothing more. It never reads Notion
  data, never authenticates a user session, never mutates server state beyond registering
  its own token.

## Capability Catalog

### 1. Receive-only push client (Flutter)

A single-screen Flutter app whose entire responsibility is to receive and display pushes.

- On first launch it initializes Firebase, requests notification permission, and obtains
  the device's FCM registration token.
- The one screen is a **log of received alerts** — a running list of title/body pairs the
  device has received, useful for confirming delivery and for a lightweight in-app history.
- No navigation graph, no forms, no server reads. If the app is removed, its token is
  simply cleaned up server-side the next time a send fails against it.

### 2. Token registration + refresh handling

- After acquiring the token, the app **POSTs it to the Worker's `/register` route** along
  with `platform` (`android` / `ios`), so the server can persist it in `device_tokens`.
- FCM tokens are **not permanent** — they rotate (app data cleared, reinstall, restore to
  a new device, periodic rotation). The app subscribes to `onTokenRefresh` and re-registers
  automatically whenever the token changes, so the server registry stays current without
  user action.
- Registration is **idempotent**: the server upserts on the token, so re-registering the
  same token just bumps `last_seen` and re-activates it.

### 3. Foreground notification display

- A subtle but critical platform behavior: **FCM does not auto-display notifications while
  the app is in the foreground.** If handled naively, alerts silently vanish whenever the
  user happens to have the app open.
- The app listens on `FirebaseMessaging.onMessage` and manually renders each incoming
  message as a local notification via **`flutter_local_notifications`**, using an explicitly
  created Android **notification channel**. This gives foreground alerts the same visible,
  tray-backed presentation as background ones.

### 4. Background + terminated notification display

- When the app is backgrounded or **fully terminated (swiped away / force-stopped)**, the
  OS/FCM handle display of `notification`-payload messages directly, and a **top-level
  background handler** (`onBackgroundMessage`) runs for data processing.
- This is the capability that satisfies the headline exit criterion: **a push arrives and
  is shown even with the app closed.** It depends on the background handler being a
  top-level/static function (Dart isolate requirement) and on the Android manifest
  declaring a valid default notification channel.

### 5. Worker token registry (`/register`)

- A server route that **upserts** `(token, platform)` into `device_tokens`, setting
  `active=1`, stamping `registered_at` on insert and `last_seen` on every hit
  (`ON CONFLICT(token) DO UPDATE`).
- Turns the device fleet into a queryable, deduplicated list the sender iterates over.
  Re-registration and refresh both flow through here, so there is exactly one write path
  into the registry.

### 6. FCM v1 OAuth2 sender with access-token caching

- The **real** replacement for the Phase 4 stub. FCM's legacy server key is **gone** —
  HTTP v1 mandates **OAuth2 Bearer tokens**.
- The sender mints a short-lived JWT from the service account, **signs it RS256 using Web
  Crypto** (importing the PKCS8 private key from the service-account PEM), and exchanges it
  at `oauth2.googleapis.com/token` for a **1-hour access token**.
- Because access tokens are valid for an hour, the sender **caches** it (module scope, and
  optionally KV) for ~55 minutes, so a burst of alerts triggers **one** OAuth2 exchange
  rather than one per message. This keeps latency and Google API usage low.
- Each message is a per-token POST to
  `https://fcm.googleapis.com/v1/projects/{FCM_PROJECT_ID}/messages:send` with a
  `notification` block (title/body) and an optional `data` block.

### 7. Stale-token cleanup

- FCM reports dead tokens (uninstalled apps, expired/rotated tokens) via **HTTP 404
  `UNREGISTERED`** (and some 400 responses for malformed/stale tokens).
- On those responses the sender **deactivates** the offending row (`active=0`), so it is
  skipped on the next send. This is self-healing hygiene: the fleet trends toward only
  live tokens, keeping the send loop efficient and delivery stats honest.

### 8. Temporary test-push route (`GET /test-push`)

- A throwaway diagnostic endpoint that calls the real `pushFcm` with a canned title/body,
  fanning out to all active tokens.
- It is the fastest way to validate the whole downstream path (OAuth2 → FCM → device)
  **independently of the alert engine**, and is the tool used to prove the "app closed"
  exit criterion. It is expected to be **removed or guarded** once the phase is signed off.

## Capability-to-Exit-Criterion Map

| Capability | Satisfies |
|------------|-----------|
| Token registration + `/register` route | Token registered in D1 on launch |
| FCM v1 sender + test-push + background/terminated display | `/test-push` notifies with app closed |
| Sender swapped into Phase 4 dispatcher | Phase 4 stub replaced |
| Stale-token cleanup | Stale tokens deactivated |

## Explicitly Out of Scope

- **Sending from the device** or any outbound alert logic on-device (server-only, always).
- **In-app auth / user accounts** — the client is anonymous; a token *is* the identity.
- **iOS delivery** as a hard requirement — supported optionally, but gated behind a paid
  Apple Developer account + APNs `.p8`; Android alone meets all exit criteria for free.
- **Rich notifications** (images, action buttons, deep links), **topics/segmentation**,
  and **analytics** — natural follow-ups this phase's registry makes possible, but not
  built here.
