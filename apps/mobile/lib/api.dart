import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Where the Worker lives. Override at build time for local testing:
///   flutter run --dart-define=API_BASE=http://10.0.2.2:3000
const String kApiBase = String.fromEnvironment(
  'API_BASE',
  defaultValue: 'https://notion-ops.prodigycorp.workers.dev',
);

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;

  bool get isUnauthorized => statusCode == 401;

  @override
  String toString() => message;
}

class DevicePrefs {
  const DevicePrefs({required this.enabled, required this.vibrate});

  final bool enabled;
  final bool vibrate;

  factory DevicePrefs.fromJson(Map<String, dynamic> j) => DevicePrefs(
        enabled: j['enabled'] as bool? ?? true,
        vibrate: j['vibrate'] as bool? ?? true,
      );

  DevicePrefs copyWith({bool? enabled, bool? vibrate}) => DevicePrefs(
        enabled: enabled ?? this.enabled,
        vibrate: vibrate ?? this.vibrate,
      );
}

class AlertEntry {
  const AlertEntry({
    required this.rule,
    required this.message,
    required this.status,
    required this.sentAt,
  });

  final String rule;
  final String message;
  final String status;
  final String sentAt;

  factory AlertEntry.fromJson(Map<String, dynamic> j) => AlertEntry(
        rule: j['rule'] as String? ?? '',
        message: j['message'] as String? ?? '',
        status: j['status'] as String? ?? '',
        sentAt: j['sent_at'] as String? ?? '',
      );
}

class StatusSummary {
  const StatusSummary({
    required this.runningName,
    required this.alertsSent,
    required this.openTasks,
  });

  final String? runningName;
  final int alertsSent;
  final int openTasks;

  factory StatusSummary.fromJson(Map<String, dynamic> j) {
    final running = j['running'] as Map<String, dynamic>?;
    return StatusSummary(
      runningName: running?['name'] as String?,
      alertsSent: (j['alertsSent'] as num?)?.toInt() ?? 0,
      openTasks: (j['openTasks'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Talks to the Worker's `/api` surface.
///
/// The bearer token is the same session the dashboard issues, so revoking a
/// session in the database logs the phone out too.
class Api {
  Api._();
  static final Api instance = Api._();

  // v11 encrypts with AES-GCM + RSA key wrapping by default, so the old
  // `encryptedSharedPreferences` opt-in no longer exists.
  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'session_token';

  String? _token;

  Future<String?> loadToken() async {
    _token ??= await _storage.read(key: _tokenKey);
    return _token;
  }

  Future<void> _setToken(String? value) async {
    _token = value;
    if (value == null) {
      await _storage.delete(key: _tokenKey);
    } else {
      await _storage.write(key: _tokenKey, value: value);
    }
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_token case final t?) 'Authorization': 'Bearer $t',
      };

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$kApiBase$path').replace(queryParameters: query);

  Never _fail(http.Response res) {
    String message;
    try {
      message = (jsonDecode(res.body) as Map<String, dynamic>)['error'] as String? ??
          'Request failed (${res.statusCode})';
    } catch (_) {
      message = 'Request failed (${res.statusCode})';
    }
    throw ApiException(message, statusCode: res.statusCode);
  }

  Future<Map<String, dynamic>> _decode(http.Response res) async {
    if (res.statusCode >= 400) _fail(res);
    try {
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException('Server sent a malformed response');
    }
  }

  /// Exchange the dashboard password for a long-lived bearer token.
  Future<void> login(String password) async {
    final res = await http
        .post(
          _uri('/api/auth'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'password': password}),
        )
        .timeout(const Duration(seconds: 20));
    final body = await _decode(res);
    final token = body['token'] as String?;
    if (token == null) throw ApiException('Server did not return a token');
    await _setToken(token);
  }

  Future<void> logout() async {
    if (_token != null) {
      // Best effort: clear the local token regardless, so a network failure
      // can never leave the app stuck in a signed-in state it cannot exit.
      try {
        await http
            .post(_uri('/api/logout'), headers: _headers)
            .timeout(const Duration(seconds: 10));
      } catch (_) {}
    }
    await _setToken(null);
  }

  Future<DevicePrefs?> registerDevice(String fcmToken, {String? label}) async {
    final res = await http
        .post(
          _uri('/api/devices'),
          headers: _headers,
          body: jsonEncode({
            'fcmToken': fcmToken,
            'platform': 'android',
            if (label != null) 'label': label,
          }),
        )
        .timeout(const Duration(seconds: 20));
    final body = await _decode(res);
    final prefs = body['prefs'] as Map<String, dynamic>?;
    return prefs == null ? null : DevicePrefs.fromJson(prefs);
  }

  Future<DevicePrefs> getPrefs(String fcmToken) async {
    final res = await http
        .get(_uri('/api/prefs', {'fcmToken': fcmToken}), headers: _headers)
        .timeout(const Duration(seconds: 20));
    final body = await _decode(res);
    return DevicePrefs.fromJson(body['prefs'] as Map<String, dynamic>);
  }

  Future<DevicePrefs> setPrefs(
    String fcmToken, {
    bool? enabled,
    bool? vibrate,
  }) async {
    final res = await http
        .patch(
          _uri('/api/prefs', {'fcmToken': fcmToken}),
          headers: _headers,
          body: jsonEncode({
            if (enabled != null) 'enabled': enabled,
            if (vibrate != null) 'vibrate': vibrate,
          }),
        )
        .timeout(const Duration(seconds: 20));
    final body = await _decode(res);
    return DevicePrefs.fromJson(body['prefs'] as Map<String, dynamic>);
  }

  Future<List<AlertEntry>> alerts() async {
    final res = await http
        .get(_uri('/api/alerts'), headers: _headers)
        .timeout(const Duration(seconds: 20));
    final body = await _decode(res);
    return ((body['alerts'] as List?) ?? const [])
        .map((e) => AlertEntry.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<StatusSummary> status() async {
    final res = await http
        .get(_uri('/api/status'), headers: _headers)
        .timeout(const Duration(seconds: 20));
    return StatusSummary.fromJson(await _decode(res));
  }
}
