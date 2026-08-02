/*
 * AUDIT SUMMARY — preferences.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE   user.name / user.email  – authStore (Supabase auth session)
 * LIVE   developerMode           – settingsStore (Zustand, persisted locally)
 * STALE  Version "1.0.0"         – hardcoded string literal; not read from
 *                                  app.json, expo-constants, or any build
 *                                  artefact. Replaced with "Stat unavailable".
 * ─────────────────────────────────────────────────────────────────────────────
 * REMOVED  hardcoded "1.0.0" version value — replaced with placeholder text.
 */
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { FeatureFlags } from '../../src/config';
import { Colors, Spacing, Radii } from '../../src/theme';

export default function PreferencesScreen() {
  // AUDIT: live – authStore reads from Supabase auth session
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  // AUDIT: live – settingsStore (Zustand, persisted locally)
  const developerMode = useSettingsStore((s) => s.developerMode);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Preferences</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionHeader}>ABOUT</Text>
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/disclaimer')}
          activeOpacity={0.7}
        >
          <Text style={styles.rowIcon}>ℹ️</Text>
          <Text style={styles.rowLabel}>About BattleBuddy</Text>
          <Text style={styles.rowChevron}>›</Text>
        </TouchableOpacity>

        <Text style={[styles.sectionHeader, styles.sectionGap]}>BUDDY</Text>
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/voice-settings')}
          activeOpacity={0.7}
        >
          <Text style={styles.rowIcon}>🎙</Text>
          <Text style={styles.rowLabel}>Buddy's Voice</Text>
          <Text style={styles.rowChevron}>›</Text>
        </TouchableOpacity>

        <Text style={[styles.sectionHeader, styles.sectionGap]}>ACCOUNT</Text>
        {user && (
          // AUDIT: live – user.name and user.email from authStore (Supabase session)
          <View style={styles.row}>
            <Text style={styles.rowIcon}>👤</Text>
            <Text style={styles.rowLabel} numberOfLines={1}>{user.name} ({user.email})</Text>
          </View>
        )}
        <View style={styles.row}>
          <Text style={styles.rowIcon}>📤</Text>
          <Text style={styles.rowLabel}>Export my data</Text>
          <Text style={styles.rowSublabel}>Coming soon</Text>
        </View>
        <TouchableOpacity
          style={styles.row}
          onPress={signOut}
          activeOpacity={0.7}
        >
          <Text style={styles.rowIcon}>🚪</Text>
          <Text style={[styles.rowLabel, styles.destructive]}>Sign out</Text>
        </TouchableOpacity>

        {/* The dev-mode TOGGLE lives on the chat screen's dock (session.tsx)
            per product direction — as a plain non-animated dock button that
            varies only its own props, which the CI launch gate
            (src/__tests__/launch-gate.test.tsx) enforces. The builds 50–53
            lesson still stands: no control may enter SessionHeader's animated
            subtree, and the session screen's STRUCTURE must stay
            dev-invariant. This screen keeps the pipeline dashboard entry. */}
        {FeatureFlags.developerModeAvailable && (
          <>
            <Text style={[styles.sectionHeader, styles.sectionGap]}>DEVELOPER</Text>
            <View style={styles.row}>
              <Text style={styles.rowIcon}>🛠</Text>
              <View style={styles.rowTextCol}>
                <Text style={styles.rowLabel}>Developer mode</Text>
                <Text style={styles.rowHint}>
                  Toggle with the wrench button on the chat screen. When on, the
                  conversation becomes build-pipeline input.
                </Text>
              </View>
              {/* AUDIT: live – developerMode from settingsStore */}
              <Text style={styles.rowValue}>{developerMode ? 'ON' : 'OFF'}</Text>
            </View>
            {/* Always reachable: the dashboard is a read-only view of recorded
                build requests — the toggle only switches the conversation mode,
                so verification must not depend on it. */}
            <TouchableOpacity
              style={styles.row}
              onPress={() => router.push('/dev')}
              activeOpacity={0.7}
            >
              <Text style={styles.rowIcon}>📦</Text>
              <Text style={styles.rowLabel}>Build pipeline (Dev)</Text>
              <Text style={styles.rowChevron}>›</Text>
            </TouchableOpacity>
          </>
        )}

        <Text style={[styles.sectionHeader, styles.sectionGap]}>APP</Text>
        <View style={styles.row}>
          <Text style={styles.rowIcon}>📱</Text>
          <Text style={styles.rowLabel}>Version</Text>
          {/* AUDIT: stale – hardcoded "1.0.0"; not read from app.json or build artefact */}
          <Text style={styles.rowValue}>Stat unavailable</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  backButton: { paddingVertical: Spacing.xs, paddingRight: Spacing.sm, minWidth: 60 },
  backText: { color: Colors.coral, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  spacer: { minWidth: 60 },
  scroll: { paddingHorizontal: Spacing.md, paddingTop: Spacing.lg, paddingBottom: Spacing.xxl },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  sectionGap: { marginTop: Spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    gap: Spacing.md,
  },
  rowIcon: { fontSize: 18, width: 26, textAlign: 'center' },
  rowLabel: { flex: 1, fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  rowTextCol: { flex: 1, gap: 2 },
  rowHint: { fontSize: 12, color: Colors.textTertiary, lineHeight: 16 },
  rowChevron: { fontSize: 20, color: Colors.textTertiary },
  rowSublabel: { fontSize: 13, color: Colors.textTertiary },
  rowValue: { fontSize: 14, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  destructive: { color: Colors.error },
});
