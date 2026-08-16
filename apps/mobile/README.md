# Notion Ops — Android app

Receives the same alerts the Worker emails, as push notifications on the lock
screen. Signs in with the **same dashboard password**, and can turn
notifications and vibration on or off.

- **Package:** `com.prodigycorp.notion_ops_mobile`
- **Backend:** `https://notion-ops.prodigycorp.workers.dev` (override with
  `--dart-define=API_BASE=…`)
- **Status:** builds and analyses clean. Push needs the Firebase setup below —
  that is the only remaining step, and it needs your Google account.

## What you have to do (I can't)

Firebase is per-account, so these five steps are yours. Everything else is done.

### 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project** → name it anything.
2. Google Analytics is not needed; turn it off.

### 2. Register the Android app

1. In the project, **Add app → Android**.
2. Package name — must match **exactly**:
   ```
   com.prodigycorp.notion_ops_mobile
   ```
3. Download **`google-services.json`** and put it at:
   ```
   apps/mobile/android/app/google-services.json
   ```
   It is gitignored. The build fails with a clear message if it is missing.

### 3. Give the Worker permission to send

1. Firebase Console → ⚙ **Project settings → Service accounts**.
2. **Generate new private key** → downloads a JSON file.
3. Set it as a Worker secret. The whole file goes in as one value — the
   `private_key` newlines matter, so paste it rather than retyping:
   ```bash
   cd apps/worker
   npx wrangler secret put FCM_SERVICE_ACCOUNT   # paste the entire JSON
   ```
   > The sender accepts the `private_key` with either real newlines or `\n`
   > escapes, because shells and secret stores disagree about which they
   > produce. Both are handled.

### 4. Tell the Worker which project

`FCM_PROJECT_ID` is the `project_id` from that same JSON. It is not a secret,
so it lives in `wrangler.jsonc`:

```jsonc
"vars": { "FCM_PROJECT_ID": "your-firebase-project-id" }
```

Then `pnpm run deploy`.

### 5. Build and install

```bash
cd apps/mobile
flutter build apk --release
# or, with the phone plugged in:
flutter run --release
```

Until `FCM_SERVICE_ACCOUNT` and `FCM_PROJECT_ID` are both set, the Worker skips
push entirely and keeps emailing — no errors, no lost alerts.

## How it works

```
cron tick ─┬─ email  (SMTP, one batched session)
           └─ push   (FCM v1 → every enabled device)
```

Push and email run **concurrently** and are independent: a dead phone never
marks an alert failed or causes a resend. Push failures are logged and dead
tokens deactivated, nothing more.

### Authentication

The app posts the dashboard password to `POST /api/auth` and gets a bearer
token. That token **is** the same session the browser gets in its cookie — same
HMAC signing, same `sessions` table. Deleting a session logs out both. It shares
the login rate limiter and the deliberately generic "Incorrect password."
message, so the app is not a softer way in.

The token is kept in `flutter_secure_storage` (Android Keystore), never in
plain SharedPreferences.

### Why the notification is drawn by the app, not by FCM

The Worker sends **data-only** messages. If it sent a `notification` payload,
Android would render it itself and the vibrate switch would do nothing —
**a notification channel's vibration cannot be changed after the channel is
created.** So there are two channels that differ only in vibration, and the app
picks one per message:

| Channel | Vibrates |
| --- | --- |
| `alerts_vibrate` | yes |
| `alerts_silent` | no |

If you customise either channel in Android's own settings, that wins over the
in-app switch — Android treats the user's choice as final. The settings screen
says so.

`BigTextStyleInformation` is what makes the body expand on the lock screen
instead of being clipped to one ellipsised line.

### The notification switch is server-side

Turning notifications off writes to `devices.enabled` in D1, and the Worker
stops selecting that device. It does not send something the phone then discards
— cheaper, and the switch keeps working even if the app is never reopened.

## API

All routes require `Authorization: Bearer <token>` except `/api/auth`.

| Route | Purpose |
| --- | --- |
| `POST /api/auth` | password → bearer token |
| `POST /api/devices` | register / refresh this install's FCM token |
| `GET/PATCH /api/prefs?fcmToken=…` | read or set `enabled` / `vibrate` |
| `GET /api/alerts` | last 50 alerts, for the in-app list |
| `GET /api/status` | running timer, alert count, open tasks |
| `POST /api/logout` | revoke the session and unregister the device |

## Commands

| | |
| --- | --- |
| `flutter run` | debug on a connected device |
| `flutter build apk --release` | release APK |
| `flutter test` | widget tests |
| `flutter analyze` | static analysis |

`flutter` is not on PATH here; it lives at `C:\Users\waywi\develop\flutter\bin`.

## Things that will bite you

1. **`google-services.json` package name must match exactly.** A mismatch fails
   at `processDebugGoogleServices` with a confusing message.
2. **`flutter_secure_storage` is pinned to `10.3.1`.** Version 11 declares
   `compileSdk = 37`, but the SDK manager only ships that platform as
   `android-37.0` while AGP resolves 37 to a directory named `android-37` —
   producing `Failed to find target with hash string 'android-37'`. Overriding
   `compileSdk` from Gradle does not work either: it is read during evaluation,
   so `afterEvaluate` is too late. Unpin once `platforms;android-37` exists.
3. **Android 13+ needs the runtime notification grant.** Without
   `POST_NOTIFICATIONS` the notification is dropped silently, not with an error.
   The app requests it on first launch.
4. **FCM tokens rotate without warning.** The app re-registers on launch and on
   `onTokenRefresh`, and the Worker deletes the previous row for that session so
   a rotation cannot cause double-sends.
5. **The background handler is a top-level function** with
   `@pragma('vm:entry-point')`. Its isolate has none of the app's state, so it
   re-initialises Firebase and re-creates the channels itself.
