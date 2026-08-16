import 'package:flutter/material.dart';

/// Mirrors the dashboard's palette so the two read as one product.
abstract class C {
  static const page = Color(0xFF0A0A0A);
  static const card = Color(0xFF101010);
  static const raised = Color(0xFF171717);
  static const line = Color(0x12FFFFFF);
  static const ink = Color(0xFFFFFFFF);
  static const ink2 = Color(0xFF9A9A9A);
  static const ink3 = Color(0xFF6B6B6B);
  static const accent = Color(0xFF3B82F6);
  static const good = Color(0xFF22C55E);
  static const warn = Color(0xFFF5A524);
  static const bad = Color(0xFFF04438);
}

ThemeData buildTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: C.page,
    colorScheme: base.colorScheme.copyWith(
      primary: C.accent,
      surface: C.card,
      error: C.bad,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: C.page,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: C.ink,
        fontSize: 20,
        fontWeight: FontWeight.w600,
      ),
    ),
    cardTheme: CardThemeData(
      color: C.card,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: const BorderSide(color: C.line),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: C.raised,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(999),
        borderSide: const BorderSide(color: C.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(999),
        borderSide: const BorderSide(color: C.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(999),
        borderSide: const BorderSide(color: C.accent, width: 1.6),
      ),
      hintStyle: const TextStyle(color: C.ink3),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: C.accent,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(50),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? Colors.white : C.ink2,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? C.accent : C.raised,
      ),
      trackOutlineColor: WidgetStateProperty.all(C.line),
    ),
    dividerTheme: const DividerThemeData(color: C.line, space: 1, thickness: 1),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: C.raised,
      contentTextStyle: TextStyle(color: C.ink),
      behavior: SnackBarBehavior.floating,
    ),
  );
}
