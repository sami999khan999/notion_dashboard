import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Push receipt and notification rendering.
///
/// The Worker sends **data-only** messages on purpose. If it sent a
/// `notification` payload, Android would draw the notification itself and the
/// vibrate preference would be ignored — a channel's vibration pattern is fixed
/// at creation and cannot be changed afterwards. Rendering it here lets us pick
/// between two channels that differ only in whether they vibrate.
class Push {
  Push._();
  static final Push instance = Push._();

  static const _channelVibrate = AndroidNotificationChannel(
    'alerts_vibrate',
    'Alerts (vibrate)',
    description: 'Notion Ops alerts, with vibration.',
    importance: Importance.high,
    enableVibration: true,
  );

  static const _channelSilent = AndroidNotificationChannel(
    'alerts_silent',
    'Alerts (no vibration)',
    description: 'Notion Ops alerts, without vibration.',
    importance: Importance.high,
    enableVibration: false,
  );

  final _local = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  /// Latest token, cached so screens can read it without another async hop.
  String? token;

  Future<void> init({void Function(RemoteMessage)? onTap}) async {
    if (_ready) return;

    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    await _local.initialize(
      settings: const InitializationSettings(android: androidInit),
      onDidReceiveNotificationResponse: (_) {},
    );

    final android = _local
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(_channelVibrate);
    await android?.createNotificationChannel(_channelSilent);
    // Android 13+ requires an explicit runtime grant, and without it the
    // notification is silently dropped rather than erroring.
    await android?.requestNotificationsPermission();

    await FirebaseMessaging.instance.requestPermission();

    // Foreground messages never auto-display; we always render them ourselves.
    FirebaseMessaging.onMessage.listen(show);
    if (onTap != null) {
      FirebaseMessaging.onMessageOpenedApp.listen(onTap);
    }

    token = await FirebaseMessaging.instance.getToken();
    _ready = true;
  }

  /// Fires whenever FCM rotates the token, which it does without warning.
  Stream<String> get onTokenRefresh => FirebaseMessaging.instance.onTokenRefresh;

  /// Render one alert.
  ///
  /// `BigTextStyleInformation` is what makes the body expand on the lock screen
  /// instead of being cut to a single ellipsised line.
  static Future<void> show(RemoteMessage message) async {
    final data = message.data;
    final title = (data['title'] as String?)?.trim();
    final body = (data['body'] as String?)?.trim() ?? '';
    if (title == null || title.isEmpty) return;

    final vibrate = data['vibrate'] != '0';
    final channel = vibrate ? _channelVibrate : _channelSilent;

    final details = AndroidNotificationDetails(
      channel.id,
      channel.name,
      channelDescription: channel.description,
      importance: Importance.high,
      priority: Priority.high,
      enableVibration: vibrate,
      // A colour and a large-icon-free layout keeps it clean on the lock screen.
      color: const Color(0xFF3B82F6),
      colorized: false,
      ticker: title,
      styleInformation: BigTextStyleInformation(
        body,
        contentTitle: title,
        summaryText: 'Notion Ops',
      ),
    );

    await FlutterLocalNotificationsPlugin().show(
      // A stable-ish id per message keeps repeats from stacking endlessly while
      // still letting distinct alerts coexist in the shade.
      id: message.messageId?.hashCode ??
          DateTime.now().millisecondsSinceEpoch ~/ 1000,
      title: title,
      body: body,
      notificationDetails: NotificationDetails(android: details),
      payload: data['url'] as String?,
    );
  }
}

/// Background/terminated handler.
///
/// Must be a top-level function — the isolate that runs it has none of the
/// app's state, so it re-initialises Firebase and the plugin from scratch.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp();

  final local = FlutterLocalNotificationsPlugin();
  await local.initialize(
    settings: const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ),
  );

  final android = local
      .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
  // Creating a channel that already exists is a no-op, so this is safe to
  // repeat and covers the case where the app has never been opened.
  await android?.createNotificationChannel(Push._channelVibrate);
  await android?.createNotificationChannel(Push._channelSilent);

  await Push.show(message);
}
