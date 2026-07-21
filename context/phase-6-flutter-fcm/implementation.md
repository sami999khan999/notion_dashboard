# Phase 6 — Mobile Notification App (Flutter + FCM): Implementation

This is the build guide. It is ordered so you can work top-to-bottom: **Firebase setup →
Flutter client → Worker registry & sender → swap the stub → verify → pitfalls.**

Monorepo layout assumed:

```
apps/
  mobile/          # Flutter app (this phase)
    android/app/google-services.json   # gitignored
    lib/main.dart
    lib/push.dart
    pubspec.yaml
  worker/          # Cloudflare Worker (TanStack Start) — Phases 3–5 live here
    src/routes/register.ts
    src/routes/test-push.ts
    src/lib/fcm.ts                       # new: sender + JWT signing
    wrangler.toml
```

---

## Part A — Firebase Project Setup

### A.1 Create the project

1. Go to the [Firebase console](https://console.firebase.google.com/) → **Add project**.
2. Name it (e.g. `notion-ops-dashboard`). Google Analytics is optional; you can disable it.
3. After creation, note the **Project ID** (e.g. `notion-ops-dashboard`) — this becomes
   `FCM_PROJECT_ID`.

### A.2 Add the Android app (required, free)

1. In the project overview, click the **Android** icon (**Add app**).
2. **Android package name** — this must match the app's `applicationId` in
   `apps/mobile/android/app/build.gradle`. Pick a reverse-DNS id, e.g.
   `com.waywisetech.notionops`. Whatever you enter here must be identical in gradle or FCM
   will refuse the app.
3. App nickname + debug signing SHA-1 are optional for basic FCM (SHA-1 is only needed for
   things like Dynamic Links / Google sign-in — skip it).
4. **Download `google-services.json`** and place it at:

   ```
   apps/mobile/android/app/google-services.json
   ```

   This file is **not secret in the cryptographic sense**, but keep it out of git anyway
   (it identifies your project). Add it to `.gitignore` (see Pitfalls).

### A.3 Generate the service account (Worker credential)

1. **Project settings** (gear icon) → **Service accounts** tab.
2. **Generate new private key** → confirm → a JSON file downloads. It looks like:

   ```json
   {
     "type": "service_account",
     "project_id": "notion-ops-dashboard",
     "private_key_id": "…",
     "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----\n",
     "client_email": "firebase-adminsdk-xxxxx@notion-ops-dashboard.iam.gserviceaccount.com",
     "client_id": "…",
     "token_uri": "https://oauth2.googleapis.com/token",
     …
   }
   ```

3. This entire JSON becomes the Worker secret `FCM_SERVICE_ACCOUNT`. **Treat it like a
   password** — it can send push to your whole fleet. Never commit it.

### A.4 iOS (OPTIONAL — not free)

iOS delivery is **not required** for this phase's exit criteria and costs money. If you
still want it:

| Requirement | Detail |
|-------------|--------|
| **Apple Developer Program** | **$99/yr.** Mandatory to produce APNs keys and to run on a real iPhone. |
| **APNs auth key** | In the Apple Developer portal → Keys → create an **APNs `.p8`** key. Note the Key ID and your Team ID. |
| **Upload to Firebase** | Firebase → Project settings → **Cloud Messaging** → *Apple app configuration* → upload the `.p8` with its Key ID + Team ID. |
| **Add iOS app in Firebase** | Downloads `GoogleService-Info.plist` → place in `apps/mobile/ios/Runner/`. |
| **Xcode capabilities** | Enable **Push Notifications** and **Background Modes → Remote notifications**. |
| **Physical device** | The iOS Simulator cannot receive real push. |

> Because of the cost and the physical-device requirement, **do all verification on
> Android** and treat iOS as an add-on.

---

## Part B — Flutter Client (`apps/mobile`)

### B.1 `pubspec.yaml` dependencies

```yaml
name: notion_ops_mobile
description: Receive-only push client for Notion Ops Dashboard alerts.
publish_to: "none"
version: 1.0.0+1

environment:
  sdk: ">=3.3.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  firebase_core: ^3.6.0
  firebase_messaging: ^15.1.3
  flutter_local_notifications: ^17.2.3
  http: ^1.2.2

flutter:
  uses-material-design: true
```

Then:

```bash
cd apps/mobile
flutter pub get
```

### B.2 Android gradle wiring (google-services plugin)

FCM on Android needs the Google Services gradle plugin to read `google-services.json`.

**`apps/mobile/android/settings.gradle`** — declare the plugin version (modern plugins DSL):

```groovy
plugins {
    id "com.android.application" version "8.3.0" apply false
    id "org.jetbrains.kotlin.android" version "1.9.22" apply false
    id "com.google.gms.google-services" version "4.4.2" apply false
}
```

**`apps/mobile/android/app/build.gradle`** — apply it and set the matching `applicationId`:

```groovy
plugins {
    id "com.android.application"
    id "kotlin-android"
    id "dev.flutter.flutter-gradle-plugin"
    id "com.google.gms.google-services"   // <-- add
}

android {
    namespace = "com.waywisetech.notionops"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.waywisetech.notionops"   // MUST equal the Firebase package name
        minSdk = 21          // firebase_messaging needs >= 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }
}
```

> If you use the older `apply plugin:` style, add
> `apply plugin: 'com.google.gms.google-services'` at the bottom of `app/build.gradle` and
> `classpath 'com.google.gms:google-services:4.4.2'` to the root `build.gradle`
> `buildscript { dependencies { … } }`.

### B.3 Android manifest — permissions + default channel

**`apps/mobile/android/app/src/main/AndroidManifest.xml`**:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- Android 13+ requires runtime notification permission -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
    <uses-permission android:name="android.permission.INTERNET"/>

    <application
        android:label="Notion Ops"
        android:icon="@mipmap/ic_launcher">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:theme="@style/LaunchTheme"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
            android:hardwareAccelerated="true"
            android:windowSoftInputMode="adjustResize">
            <meta-data
                android:name="io.flutter.embedding.android.NormalTheme"
                android:resource="@style/NormalTheme"/>
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>

        <!-- Default channel FCM uses for notification-payload messages when the app is
             backgrounded/terminated. The id MUST match the channel created in Dart. -->
        <meta-data
            android:name="com.google.firebase.messaging.default_notification_channel_id"
            android:value="alerts_channel"/>

        <meta-data
            android:name="flutterEmbedding"
            android:value="2"/>
    </application>
</manifest>
```

Key points:

- **`POST_NOTIFICATIONS`** — without it, Android 13+ (API 33+) shows nothing even though
  the message arrives. `fcm.requestPermission()` triggers the runtime prompt.
- **`default_notification_channel_id`** — must equal the channel id you create with
  `flutter_local_notifications` (`alerts_channel` below). If it references a non-existent
  channel, background notifications are silently dropped on Android 8+.

### B.4 `lib/push.dart` — the push engine

This file owns all messaging concerns. The background handler is a **top-level function**
(not a class method / not a closure) — this is mandatory because FCM spins up a **separate
Dart isolate** for background messages that can only reach top-level or `static` entry
points.

```dart
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;

// TODO: point at your deployed Worker (or a tunnel during local dev).
const kWorkerUrl = 'https://notion-ops.<your-subdomain>.workers.dev';

// Must match AndroidManifest default_notification_channel_id.
const _channelId = 'alerts_channel';
const _channelName = 'Alerts';
const _channelDesc = 'Notion Ops operational alerts';

final FlutterLocalNotificationsPlugin _localNotifs =
    FlutterLocalNotificationsPlugin();

/// Android notification channel (required on Android 8.0+ / API 26+).
const AndroidNotificationChannel _androidChannel = AndroidNotificationChannel(
  _channelId,
  _channelName,
  description: _channelDesc,
  importance: Importance.high, // heads-up + sound
);

/// TOP-LEVEL background handler. Runs in its own isolate when a message
/// arrives while the app is backgrounded or terminated.
/// Must be top-level or static, and annotated for release tree-shaking.
@pragma('vm:entry-point')
Future<void> bgHandler(RemoteMessage message) async {
  // The isolate is fresh: Firebase must be initialized here too.
  await Firebase.initializeApp();
  // For notification-payload messages, the OS renders the tray notification
  // automatically when the app is not in the foreground — no manual show needed.
  // Do any lightweight data processing here (e.g. logging). Keep it fast.
}

/// Call once from main() after runApp/bindings are ready.
Future<void> initPush() async {
  await Firebase.initializeApp();

  // Register the background handler BEFORE any awaits that could receive a message.
  FirebaseMessaging.onBackgroundMessage(bgHandler);

  await _initLocalNotifications();

  final fcm = FirebaseMessaging.instance;

  // Ask for permission (triggers the Android 13+ runtime prompt / iOS prompt).
  await fcm.requestPermission(alert: true, badge: true, sound: true);

  // Foreground presentation options (mainly relevant to iOS).
  await fcm.setForegroundNotificationPresentationOptions(
    alert: true, badge: true, sound: true,
  );

  // Get and register the token.
  final token = await fcm.getToken();
  await registerToken(token);

  // Keep the server registry fresh when the token rotates.
  fcm.onTokenRefresh.listen(registerToken);

  // Foreground messages are NOT auto-displayed by FCM — render them ourselves.
  FirebaseMessaging.onMessage.listen(_showLocal);
}

Future<void> _initLocalNotifications() async {
  const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
  const iosInit = DarwinInitializationSettings();
  const initSettings =
      InitializationSettings(android: androidInit, iOS: iosInit);
  await _localNotifs.initialize(initSettings);

  // Create the channel so it exists before any notification targets it.
  await _localNotifs
      .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>()
      ?.createNotificationChannel(_androidChannel);
}

/// Render a foreground message as a local notification.
void _showLocal(RemoteMessage message) {
  final n = message.notification;
  final title = n?.title ?? message.data['title'] ?? 'Alert';
  final body = n?.body ?? message.data['body'] ?? '';

  _localNotifs.show(
    message.hashCode,
    title,
    body,
    const NotificationDetails(
      android: AndroidNotificationDetails(
        _channelId,
        _channelName,
        channelDescription: _channelDesc,
        importance: Importance.high,
        priority: Priority.high,
        icon: '@mipmap/ic_launcher',
      ),
      iOS: DarwinNotificationDetails(),
    ),
  );
}

/// POST the token to the Worker's /register route. Idempotent server-side.
Future<void> registerToken(String? token) async {
  if (token == null) return;
  try {
    await http.post(
      Uri.parse('$kWorkerUrl/register'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'token': token, 'platform': Platform.operatingSystem}),
    );
  } catch (_) {
    // Network hiccup: onTokenRefresh / next launch will retry. Non-fatal.
  }
}
```

### B.5 `lib/main.dart` — single-screen alert log

```dart
import 'package:flutter/material.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import 'push.dart';

// In-memory log of received alerts (simple ValueNotifier so the UI updates).
final ValueNotifier<List<String>> receivedLog = ValueNotifier([]);

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initPush();

  // Append foreground messages to the on-screen log too.
  FirebaseMessaging.onMessage.listen((m) {
    final title = m.notification?.title ?? m.data['title'] ?? 'Alert';
    final body = m.notification?.body ?? m.data['body'] ?? '';
    receivedLog.value = [...receivedLog.value, '$title — $body'];
  });

  runApp(const NotionOpsApp());
}

class NotionOpsApp extends StatelessWidget {
  const NotionOpsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Notion Ops',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),
      home: Scaffold(
        appBar: AppBar(title: const Text('Notion Ops — Alerts')),
        body: ValueListenableBuilder<List<String>>(
          valueListenable: receivedLog,
          builder: (_, items, __) {
            if (items.isEmpty) {
              return const Center(
                child: Text('No alerts yet.\nYou are registered for push.',
                    textAlign: TextAlign.center),
              );
            }
            return ListView.separated(
              itemCount: items.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) => ListTile(
                leading: const Icon(Icons.notifications_active_outlined),
                title: Text(items[items.length - 1 - i]), // newest first
              ),
            );
          },
        ),
      ),
    );
  }
}
```

Build & install on a connected Android device:

```bash
cd apps/mobile
flutter run            # or: flutter build apk --release
```

---

## Part C — Worker: Registry, Sender, Test Route

Environment binding shape (`apps/worker/wrangler.toml`):

```toml
name = "notion-ops"
main = "src/index.ts"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "notion_ops"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[vars]
FCM_PROJECT_ID = "notion-ops-dashboard"   # NON-secret project id

# Optional: KV for cross-request access-token caching
# [[kv_namespaces]]
# binding = "FCM_KV"
# id = "…"
```

The secret is set out-of-band (Part C.5), never in the toml.

TypeScript `Env` (extend your existing one):

```ts
interface Env {
  DB: D1Database;
  FCM_PROJECT_ID: string;
  FCM_SERVICE_ACCOUNT: string; // JSON string of the service account
  // FCM_KV?: KVNamespace;      // optional
}
```

### C.1 `/register` route

```ts
// src/routes/register.ts  — TanStack Start server route
export async function POST({ request, context }) {
  const { token, platform } = await request.json();
  if (!token) return new Response("missing token", { status: 400 });

  const env = context.cloudflare.env;
  await env.DB.prepare(
    `INSERT INTO device_tokens (token, platform, active, registered_at, last_seen)
     VALUES (?, ?, 1, datetime('now'), datetime('now'))
     ON CONFLICT(token) DO UPDATE SET
       active = 1,
       platform = excluded.platform,
       last_seen = datetime('now')`
  ).bind(token, platform ?? "unknown").run();

  return new Response("ok");
}
```

The `ON CONFLICT(token)` clause requires `token` to be a PRIMARY KEY or have a UNIQUE
constraint (it does — Phase 2). This makes registration idempotent and re-activates a
token that was previously marked stale.

### C.2 RS256 JWT signing with Web Crypto (`src/lib/fcm.ts`)

This is the part most likely to break. Workers run on the V8 runtime and expose the
**Web Crypto** `SubtleCrypto` API — there is no Node `crypto`, no `jsonwebtoken`. We must:

1. Convert the service-account **PEM** (`-----BEGIN PRIVATE KEY-----`) into raw DER bytes.
2. `crypto.subtle.importKey('pkcs8', der, {RSASSA-PKCS1-v1_5, SHA-256}, …, ['sign'])`.
3. base64url-encode the JWT header and claim, join with `.`, sign the bytes.
4. base64url-encode the signature and assemble `header.claim.signature`.

```ts
// src/lib/fcm.ts

// --- base64url helpers ---------------------------------------------------

function base64urlFromString(input: string): string {
  return base64urlFromBytes(new TextEncoder().encode(input));
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  // btoa is available in Workers.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Standard base64 (NOT url-safe) → Uint8Array. Used to decode the PEM body.
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- PEM (PKCS8) → CryptoKey --------------------------------------------

function pemToPkcs8Der(pem: string): Uint8Array {
  // The private_key field arrives with literal \n; if it somehow contains
  // escaped "\\n" (double-encoded), normalize those first.
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, ""); // strip newlines/spaces → pure base64
  return base64ToBytes(body);
}

async function importSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  const der = pemToPkcs8Der(privateKeyPem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/// Sign a claim set as an RS256 JWT.
async function signRs256(
  claim: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const encHeader = base64urlFromString(JSON.stringify(header));
  const encClaim = base64urlFromString(JSON.stringify(claim));
  const signingInput = `${encHeader}.${encClaim}`;

  const key = await importSigningKey(privateKeyPem);
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const encSig = base64urlFromBytes(new Uint8Array(sigBuf));
  return `${signingInput}.${encSig}`;
}
```

> Note: **RS256 == `RSASSA-PKCS1-v1_5` with SHA-256** in Web Crypto terms. The hash is
> specified at `importKey` time, so `sign` just takes the algorithm name.

### C.3 OAuth2 access-token exchange + caching

```ts
// src/lib/fcm.ts (continued)

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

// Module-scope cache. A Worker isolate is reused across requests, so this
// survives between invocations on the same isolate — good enough to avoid
// re-minting on every alert. For guaranteed cross-isolate reuse, use KV.
let _cachedToken: { value: string; expiresAt: number } | null = null;

async function getFcmAccessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Serve from cache if it has > 60s of life left.
  if (_cachedToken && _cachedToken.expiresAt - 60 > now) {
    return _cachedToken.value;
  }

  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;

  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600, // JWT valid 1 hour (max Google allows)
  };

  const jwt = await signRs256(claim, sa.private_key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OAuth2 token exchange failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };

  // Cache for ~55 min (expires_in is 3600; keep a safety margin).
  _cachedToken = {
    value: json.access_token,
    expiresAt: now + Math.min(json.expires_in, 3600) - 300,
  };

  return json.access_token;
}
```

**Optional KV-backed cache** (survives isolate recycling / multiple isolates):

```ts
// Read: const cached = await env.FCM_KV.get("fcm_access_token");
// Write: await env.FCM_KV.put("fcm_access_token", token, { expirationTtl: 3300 });
// Layer this in front of the module-scope cache if you deploy at scale.
```

### C.4 The real `pushFcm` sender with stale-token cleanup

```ts
// src/lib/fcm.ts (continued)

export async function pushFcm(
  env: Env,
  title: string,
  body: string,
  data: Record<string, string> = {},
): Promise<{ sent: number; deactivated: number }> {
  const at = await getFcmAccessToken(env);

  const { results } = await env.DB.prepare(
    "SELECT token FROM device_tokens WHERE active = 1",
  ).all<{ token: string }>();

  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`;
  let sent = 0;
  let deactivated = 0;

  for (const { token } of results ?? []) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${at}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data, // FCM v1 requires string values in data
        },
      }),
    });

    if (res.ok) {
      sent++;
      continue;
    }

    // 404 UNREGISTERED or 400 (malformed/stale) → deactivate this token.
    if (res.status === 404 || res.status === 400) {
      await env.DB.prepare("UPDATE device_tokens SET active = 0 WHERE token = ?")
        .bind(token)
        .run();
      deactivated++;
    } else {
      // 401 (token expired mid-loop), 429/5xx (transient). Log; leave active.
      console.error(`FCM send failed (${res.status}) for token ${token.slice(0, 12)}…`);
    }
  }

  return { sent, deactivated };
}
```

> **`data` values must be strings.** FCM v1 rejects non-string values in the `data` map,
> so cast/stringify before passing (`{ alertId: String(id) }`).

### C.5 Secrets & vars setup

```bash
cd apps/worker

# The service account JSON. Pipe the downloaded file so the private_key's
# real newlines are preserved verbatim (the \n inside the PEM MUST survive).
wrangler secret put FCM_SERVICE_ACCOUNT < ./service-account.json

# FCM_PROJECT_ID is NON-secret → put it in wrangler.toml [vars] (see above),
# not as a secret. (You may also set it as a secret if you prefer.)
```

**Critical:** whether you paste or pipe, the `private_key` string must retain its `\n`
sequences (or real newlines). If your shell mangles them into spaces or strips them, the
PEM won't parse and `importKey`/signing fails. Piping the file with `<` is the safest.
Delete the local `service-account.json` after uploading.

### C.6 `GET /test-push` route (temporary)

```ts
// src/routes/test-push.ts
import { pushFcm } from "../lib/fcm";

export async function GET({ context }) {
  const env = context.cloudflare.env;
  const result = await pushFcm(
    env,
    "Test push",
    `Hello from the Worker at ${new Date().toISOString()}`,
    { source: "test-push" },
  );
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
}
```

> Remove or guard this route (e.g. behind a query secret) once the phase is verified — it
> can spam every registered device.

---

## Part D — Replace the Phase 4 Stub

Phase 4 has a stub with the **same signature** we've reproduced. Locate it (it was the one
writing to `alert_log`) and swap the implementation for the real sender.

**Before (Phase 4 stub):**

```ts
// old: logs instead of sending
async function pushFcm(env, title, body, data = {}) {
  await env.DB.prepare(
    "INSERT INTO alert_log (title, body, sent_at) VALUES (?, ?, datetime('now'))",
  ).bind(title, body).run();
}
```

**After:** delete the stub and import the real one; keep the `alert_log` write in the
**dispatcher** (or keep it inside `pushFcm` if that's where Phase 4 logged) so audit
history is preserved:

```ts
import { pushFcm } from "./lib/fcm";

// in the alert dispatcher, where it already computes title/body/data:
await env.DB.prepare(
  "INSERT INTO alert_log (title, body, sent_at) VALUES (?, ?, datetime('now'))",
).bind(title, body).run();

const { sent, deactivated } = await pushFcm(env, title, body, data);
// optionally record sent/deactivated counts on the alert_log row
```

Because the signature is unchanged, **no other Phase 4 logic changes.** All thresholds,
dedupe, and cooldowns keep working; only delivery becomes real.

Deploy:

```bash
cd apps/worker
wrangler deploy
```

---

## Part E — Verification (per exit criterion)

| # | Test | Expected |
|---|------|----------|
| 1 | Fresh install → launch → grant permission. Then `wrangler d1 execute notion_ops --command "SELECT token, platform, active, last_seen FROM device_tokens ORDER BY last_seen DESC LIMIT 5"` | A row with your platform, `active=1`, recent `last_seen`. |
| 2 | **Swipe the app away / force-stop it.** Open `https://<worker>/test-push` in a browser. | A system notification appears on the device tray **with the app closed**. Response body shows `{"sent":1,…}`. |
| 3 | Trigger a real Phase 4 alert condition. | A real push arrives; `alert_log` gains a row; the app's list shows it if foregrounded. |
| 4 | Uninstall the app (or clear its data), then hit `/test-push` again. | Response shows `deactivated >= 1`; that token's `active` is now `0` and it is skipped next time. |

**Testing "app fully closed" correctly:**

- Do **not** just background the app — **swipe it out of recents / force-stop** it in
  Settings → Apps. That is the terminated state the exit criterion demands.
- If the notification appears when open but NOT when closed → check (a) the manifest
  `default_notification_channel_id` matches the Dart channel id, (b) the channel is
  actually created, (c) `bgHandler` is top-level with `@pragma('vm:entry-point')`.
- If nothing appears at all on Android 13+ → the runtime `POST_NOTIFICATIONS` permission
  was denied; re-grant it in app settings.
- Prefer a **release build** (`flutter build apk --release && flutter install`) for
  terminated-state testing — some OEMs kill debug builds aggressively.

---

## Part F — Pitfalls & Gotchas

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| **FCM v1 OAuth2 required (legacy key gone)** | Old tutorials use a "server key" + `fcm/send`; that endpoint is decommissioned. | Use the OAuth2 flow above against `/v1/projects/{id}/messages:send`. |
| **`private_key` `\n` mangled** | `importKey`/`sign` throws, or OAuth2 returns `invalid_grant`. | Pipe the JSON file into `wrangler secret put` so newlines survive. `pemToPkcs8Der` also normalizes escaped `\\n`. Never hand-edit the key. |
| **JWT signing fails / bad DER** | `DataError` at `importKey`, or 400 from Google. | Ensure you strip the PEM headers and *all* whitespace before base64-decoding, decode with standard base64 (`atob`), import as `pkcs8`, and base64url the outputs. |
| **Foreground messages don't auto-show** | Push "works" only when app is closed. | Manually render via `flutter_local_notifications` on `onMessage` (that's `_showLocal`). |
| **Background handler not top-level** | Background/terminated pushes crash or do nothing. | `bgHandler` must be a top-level or `static` function with `@pragma('vm:entry-point')`; register it before awaits. |
| **Missing / mismatched channel** | Background notifications silently dropped on Android 8+. | Create `alerts_channel` in Dart AND set `default_notification_channel_id` to the same id in the manifest. |
| **Android 13+ permission** | No notifications despite successful send. | Declare `POST_NOTIFICATIONS`; call `requestPermission()`; verify it's granted. |
| **iOS push isn't free** | iOS gets nothing. | Requires Apple Developer ($99/yr) + APNs `.p8` uploaded to Firebase + a physical device. Out of scope; use Android. |
| **Stale tokens accumulate** | Wasted sends, misleading counts. | Deactivate on 404 `UNREGISTERED` / 400 (done in `pushFcm`). Re-registration reactivates them. |
| **`data` non-string values** | FCM v1 rejects the message (400). | Stringify all `data` values before sending. |
| **Secrets committed to git** | Anyone can push to your fleet / spoof your project. | `.gitignore` both `google-services.json` and any `service-account*.json`. |
| **Access token minted per message** | Slow bursts, OAuth2 rate pressure. | Cache the access token ~55 min (module scope and/or KV). |

**`.gitignore` additions (repo root or `apps/mobile/.gitignore`):**

```gitignore
# Firebase / FCM credentials — never commit
apps/mobile/android/app/google-services.json
apps/mobile/ios/Runner/GoogleService-Info.plist
**/service-account*.json
```
