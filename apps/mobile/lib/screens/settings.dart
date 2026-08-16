import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.fcmToken,
    required this.initial,
    required this.onSignedOut,
  });

  final String fcmToken;
  final DevicePrefs? initial;
  final VoidCallback onSignedOut;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late DevicePrefs? _prefs = widget.initial;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (_prefs == null) _load();
  }

  Future<void> _load() async {
    try {
      final prefs = await Api.instance.getPrefs(widget.fcmToken);
      if (mounted) setState(() => _prefs = prefs);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  /// Applies optimistically, then reconciles with whatever the server stored —
  /// a toggle that lags a network round trip feels broken.
  Future<void> _update({bool? enabled, bool? vibrate}) async {
    final previous = _prefs;
    if (previous == null || _busy) return;

    setState(() {
      _prefs = previous.copyWith(enabled: enabled, vibrate: vibrate);
      _busy = true;
      _error = null;
    });

    try {
      final saved = await Api.instance.setPrefs(
        widget.fcmToken,
        enabled: enabled,
        vibrate: vibrate,
      );
      if (mounted) setState(() => _prefs = saved);
    } catch (e) {
      // Roll back so the switch never shows a state the server rejected.
      if (mounted) {
        setState(() {
          _prefs = previous;
          _error = 'Could not save. $e';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _signOut() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: C.card,
        title: const Text('Sign out?'),
        content: const Text(
          'This phone will stop receiving alerts until you sign in again.',
          style: TextStyle(color: C.ink2),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel', style: TextStyle(color: C.ink2)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign out', style: TextStyle(color: C.bad)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    await Api.instance.logout();
    if (!mounted) return;
    Navigator.of(context).popUntil((r) => r.isFirst);
    widget.onSignedOut();
  }

  @override
  Widget build(BuildContext context) {
    final prefs = _prefs;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: C.ink2),
          onPressed: () => Navigator.pop(context, _prefs),
        ),
      ),
      body: prefs == null
          ? const Center(child: CircularProgressIndicator(color: C.accent))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
              children: [
                if (_error != null)
                  Container(
                    margin: const EdgeInsets.only(bottom: 14),
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                    decoration: BoxDecoration(
                      color: C.bad.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      _error!,
                      style: const TextStyle(color: C.bad, fontSize: 13),
                    ),
                  ),
                Card(
                  child: Column(
                    children: [
                      _SwitchRow(
                        title: 'Push notifications',
                        subtitle:
                            'Turning this off stops the server sending to this phone at all, '
                            'rather than sending something the app throws away.',
                        value: prefs.enabled,
                        onChanged: _busy ? null : (v) => _update(enabled: v),
                      ),
                      const Divider(height: 1, indent: 18, endIndent: 18),
                      _SwitchRow(
                        title: 'Vibrate',
                        subtitle: prefs.enabled
                            ? 'Alerts arrive silently when this is off.'
                            : 'Only applies while push notifications are on.',
                        value: prefs.vibrate,
                        enabled: prefs.enabled,
                        onChanged:
                            _busy || !prefs.enabled ? null : (v) => _update(vibrate: v),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                const _Note(
                  'Vibration uses two Android notification channels, because a channel\'s '
                  'vibration cannot be changed once created. If you have customised either '
                  'channel in Android settings, that overrides this switch.',
                ),
                const SizedBox(height: 22),
                Card(
                  child: ListTile(
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
                    title: const Text(
                      'Sign out',
                      style: TextStyle(color: C.bad, fontWeight: FontWeight.w600),
                    ),
                    subtitle: const Text(
                      'Also removes this phone from the push list.',
                      style: TextStyle(color: C.ink3, fontSize: 12),
                    ),
                    onTap: _signOut,
                  ),
                ),
              ],
            ),
    );
  }
}

class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
    this.enabled = true,
  });

  final String title;
  final String subtitle;
  final bool value;
  final bool enabled;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: SwitchListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
        title: Text(
          title,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            subtitle,
            style: const TextStyle(color: C.ink3, fontSize: 12, height: 1.35),
          ),
        ),
        value: value,
        onChanged: onChanged,
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline, size: 15, color: C.ink3),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(color: C.ink3, fontSize: 12, height: 1.4),
            ),
          ),
        ],
      );
}
