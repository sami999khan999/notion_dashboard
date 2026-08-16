import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'push.dart';
import 'screens/home.dart';
import 'screens/login.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();

  // Must be registered before runApp, or a message that arrives while the app
  // is terminated has nothing to handle it.
  FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);

  final token = await Api.instance.loadToken();
  runApp(NotionOpsApp(signedIn: token != null));
}

class NotionOpsApp extends StatefulWidget {
  const NotionOpsApp({super.key, required this.signedIn});
  final bool signedIn;

  @override
  State<NotionOpsApp> createState() => _NotionOpsAppState();
}

class _NotionOpsAppState extends State<NotionOpsApp> {
  late bool _signedIn = widget.signedIn;

  void _onSignedIn() => setState(() => _signedIn = true);
  void _onSignedOut() => setState(() => _signedIn = false);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Notion Ops',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: _signedIn
          ? HomeScreen(onSignedOut: _onSignedOut)
          : LoginScreen(onSignedIn: _onSignedIn),
    );
  }
}
