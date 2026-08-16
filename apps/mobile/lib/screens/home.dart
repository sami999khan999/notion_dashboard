import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../push.dart';
import '../theme.dart';
import 'settings.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.onSignedOut});
  final VoidCallback onSignedOut;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<AlertEntry> _alerts = const [];
  StatusSummary? _status;
  DevicePrefs? _prefs;
  String? _fcmToken;
  bool _loading = true;
  String? _error;
  StreamSubscription<String>? _refreshSub;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  @override
  void dispose() {
    _refreshSub?.cancel();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    try {
      await Push.instance.init();
      final token = Push.instance.token;
      _fcmToken = token;

      if (token != null) {
        _prefs = await Api.instance.registerDevice(token, label: 'Phone');
        // FCM rotates tokens without warning; re-register so pushes keep
        // landing instead of silently going to a dead address.
        _refreshSub = Push.instance.onTokenRefresh.listen((fresh) async {
          _fcmToken = fresh;
          try {
            await Api.instance.registerDevice(fresh, label: 'Phone');
          } catch (_) {}
        });
      }
      await _refresh();
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        await Api.instance.logout();
        if (mounted) widget.onSignedOut();
        return;
      }
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _refresh() async {
    try {
      final results = await Future.wait([
        Api.instance.alerts(),
        Api.instance.status(),
      ]);
      if (!mounted) return;
      setState(() {
        _alerts = results[0] as List<AlertEntry>;
        _status = results[1] as StatusSummary;
        _error = null;
      });
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        await Api.instance.logout();
        if (mounted) widget.onSignedOut();
        return;
      }
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _openSettings() async {
    final token = _fcmToken;
    if (token == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('This device is not registered for push yet.')),
      );
      return;
    }
    final updated = await Navigator.of(context).push<DevicePrefs>(
      MaterialPageRoute(
        builder: (_) => SettingsScreen(
          fcmToken: token,
          initial: _prefs,
          onSignedOut: widget.onSignedOut,
        ),
      ),
    );
    if (updated != null && mounted) setState(() => _prefs = updated);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notion Ops'),
        actions: [
          IconButton(
            icon: const Icon(Icons.tune, color: C.ink2),
            tooltip: 'Notification settings',
            onPressed: _openSettings,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        backgroundColor: C.card,
        color: C.accent,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: C.accent))
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
                children: [
                  if (_error != null) _ErrorBanner(_error!),
                  if (_prefs != null && !_prefs!.enabled) const _MutedBanner(),
                  _StatusCard(status: _status),
                  const SizedBox(height: 18),
                  const Text(
                    'Recent alerts',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Everything the Worker has sent, newest first.',
                    style: TextStyle(color: C.ink3, fontSize: 12),
                  ),
                  const SizedBox(height: 10),
                  if (_alerts.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 28),
                      child: Text(
                        'Nothing yet. Alerts appear here as they go out.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: C.ink3),
                      ),
                    )
                  else
                    ..._alerts.map((a) => _AlertTile(a)),
                ],
              ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner(this.message);
  final String message;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 14),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: C.bad.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(children: [
          const Icon(Icons.error_outline, color: C.bad, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(message, style: const TextStyle(color: C.bad, fontSize: 13)),
          ),
        ]),
      );
}

class _MutedBanner extends StatelessWidget {
  const _MutedBanner();

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 14),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: C.warn.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Row(children: [
          Icon(Icons.notifications_off_outlined, color: C.warn, size: 18),
          SizedBox(width: 10),
          Expanded(
            child: Text(
              'Notifications are off. Alerts still appear in this list.',
              style: TextStyle(color: C.warn, fontSize: 13),
            ),
          ),
        ]),
      );
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.status});
  final StatusSummary? status;

  @override
  Widget build(BuildContext context) {
    final s = status;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: s?.runningName != null ? C.good : C.ink3,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                s?.runningName != null ? 'Timer running' : 'No timer running',
                style: const TextStyle(color: C.ink2, fontSize: 12),
              ),
            ]),
            const SizedBox(height: 10),
            Text(
              s?.runningName ?? 'Idle',
              style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 16),
            Row(children: [
              _Metric(label: 'Alerts sent', value: '${s?.alertsSent ?? 0}'),
              const SizedBox(width: 12),
              _Metric(label: 'Open tasks', value: '${s?.openTasks ?? 0}'),
            ]),
          ],
        ),
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            color: C.raised,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: C.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: const TextStyle(color: C.ink3, fontSize: 11)),
              const SizedBox(height: 6),
              Text(
                value,
                style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      );
}

class _AlertTile extends StatelessWidget {
  const _AlertTile(this.alert);
  final AlertEntry alert;

  @override
  Widget build(BuildContext context) {
    final sent = alert.status == 'sent';
    final quiet = alert.status == 'suppressed';
    final colour = sent ? C.good : quiet ? C.ink3 : C.bad;
    final label = sent ? 'Sent' : quiet ? 'Quiet' : 'Failed';
    // sent_at is ISO UTC; show just the date and minute, which is all that is
    // useful in a list this dense.
    final when = alert.sentAt.length >= 16
        ? alert.sentAt.substring(5, 16).replaceFirst('T', '  ')
        : alert.sentAt;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: C.card,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: C.line),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  alert.message,
                  style: const TextStyle(fontSize: 13.5, height: 1.35),
                ),
                const SizedBox(height: 5),
                Text(
                  '${alert.rule}  ·  $when',
                  style: const TextStyle(color: C.ink3, fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
            decoration: BoxDecoration(
              color: colour.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              label,
              style: TextStyle(color: colour, fontSize: 11, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
