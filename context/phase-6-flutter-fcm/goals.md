# Phase 6 — Mobile Notification App (Flutter + FCM): Goals

## Objective

Deliver a **receive-only** mobile push client and wire the Notion Ops Dashboard Worker
to deliver **real** push notifications through **Firebase Cloud Messaging (FCM) HTTP v1**.

Up to and including Phase 5, the platform is complete except for the "last mile" of
alerting: the Phase 4 alert engine calls a **stub** `pushFcm(env, title, body, data)`
that merely writes a row to `alert_log`. Alerts are computed correctly, but nothing ever
reaches a human on a device.

Phase 6 closes that gap in two coordinated moves:

1. **Build a thin Flutter app** (`apps/mobile`) whose only jobs are to (a) obtain an FCM
   registration token, (b) register that token with the Worker, (c) keep it fresh, and
   (d) display alerts that arrive in the foreground, background, or when the app is fully
   terminated. The app contains **no alert logic** — it is a display surface.

2. **Replace the Worker's stub `pushFcm`** with a real FCM v1 sender that mints an OAuth2
   access token from a Google service account (RS256-signed JWT via Web Crypto), sends a
   message to every active device token, and deactivates tokens FCM reports as stale.

The guiding principle is a hard **client/server split**: *all* decision-making
(what constitutes an alert, thresholds, deduplication, cooldowns, routing) stays in the
Worker exactly where Phase 4 put it. The mobile app never decides anything — it renders
what the server sends.

## Exit Criteria

This phase is considered **done** when every one of the following is demonstrably true:

| # | Criterion | How it is proven |
|---|-----------|------------------|
| 1 | **Token registered in D1 on app launch** | Fresh install → launch → grant permission. A row for the device's FCM token appears in `device_tokens` with `active=1`, a populated `platform`, and non-null `registered_at`/`last_seen`. |
| 2 | **`/test-push` shows a notification with the app CLOSED** | With the app **swiped away / force-stopped**, hitting the temporary `GET /test-push` route on the Worker causes a system notification to appear on the physical device. |
| 3 | **Phase 4 stub replaced** | The Phase 4 alert dispatcher now imports/calls the *real* `pushFcm`. Triggering a real alert condition delivers an actual push, and `alert_log` still records the dispatch. |
| 4 | **Stale tokens deactivated** | Sending to an uninstalled/expired token (FCM returns HTTP 404 `UNREGISTERED` or 400) flips that row's `active` to `0`; subsequent sends skip it. |

Criterion 2 (**app closed**) is the load-bearing test — it is the difference between
"messages work while I'm looking at the app" and a genuine background notification
pipeline. If it only works with the app open, the background handler and/or the
notification `channel` are misconfigured.

## Dependencies

### Upstream (must exist before starting)

| Dependency | Origin | What we rely on |
|------------|--------|-----------------|
| `device_tokens` table | **Phase 2** (D1 schema) | Columns `token` (PK/unique), `platform`, `active`, `registered_at`, `last_seen`. Bound to the Worker as `DB`. |
| Alert dispatcher + stub `pushFcm` | **Phase 4** | The call site we swap. The real sender must keep the same signature `(env, title, body, data?)` so the dispatcher needs no logic changes. |
| Sync + dashboard | Phases 3 & 5 | Not directly used, but the Worker they live in is where `/register`, `/test-push`, and `pushFcm` are added. |

### External / operational

| Dependency | Notes / cost |
|------------|--------------|
| **Firebase project** | Free. Create it, add an **Android app** (chosen package name), download `google-services.json`. |
| **`FCM_SERVICE_ACCOUNT` secret** | The service-account JSON (Project settings → Service accounts → Generate private key). Stored via `wrangler secret put`. Grants the Worker permission to call FCM v1. |
| **`FCM_PROJECT_ID` var** | The Firebase project ID (plain, non-secret) in `wrangler.toml` `[vars]`. Used to build the `messages:send` URL. |
| **Apple Developer Program** | **Optional / paid** ($99/yr) — only if iOS delivery is wanted. Requires an APNs `.p8` auth key uploaded to Firebase → Cloud Messaging. Android alone satisfies all exit criteria at zero cost. |

## What This Phase Unblocks

- **Real end-to-end alerting.** The entire Notion Ops pipeline — sync (P3) → detect
  (P4) → **deliver (P6)** → display — becomes operational. Operators get notified on
  their phones when something needs attention, which was the original point of the
  product.
- **A registered device fleet.** `device_tokens` becomes a living registry, enabling
  future targeting (per-user routing, topics, silent data pushes) without re-architecting.
- **A trustworthy delivery signal.** Stale-token cleanup keeps the fleet healthy so send
  loops don't waste calls on dead tokens and delivery metrics stay meaningful.

## Effort Estimate

**1.5 – 2 days.**

Rough breakdown:

- Firebase project + Android app + secrets: ~2–3 h (first-time Firebase console + gradle).
- Flutter client (deps, `push.dart`, manifest, channel, register flow): ~0.5 day.
- Worker `/register` + `/test-push`: ~1–2 h.
- FCM v1 sender with Web Crypto RS256 signing + token caching + stale cleanup: ~0.5 day
  (JWT signing is the fiddly part; budget debugging time for `\n` / PKCS8 issues).
- Swap Phase 4 stub, end-to-end verification with app closed: ~2–3 h.

iOS, if attempted, adds roughly another half-day plus the Apple Developer enrollment lead
time and is **out of scope** for the exit criteria.
