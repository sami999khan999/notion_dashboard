import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notion_ops_mobile/screens/login.dart';
import 'package:notion_ops_mobile/theme.dart';

void main() {
  testWidgets('login screen renders and validates an empty password', (tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: buildTheme(), home: LoginScreen(onSignedIn: () {})),
    );

    expect(find.text('Notion Ops'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);

    // Submitting nothing must not hit the network.
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pump();
    expect(find.text('Enter your password.'), findsOneWidget);
  });

  testWidgets('password is obscured until the reveal toggle is pressed', (tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: buildTheme(), home: LoginScreen(onSignedIn: () {})),
    );

    TextField field() => tester.widget<TextField>(find.byType(TextField));
    expect(field().obscureText, isTrue);

    await tester.tap(find.byIcon(Icons.visibility_outlined));
    await tester.pump();
    expect(field().obscureText, isFalse);
  });
}
