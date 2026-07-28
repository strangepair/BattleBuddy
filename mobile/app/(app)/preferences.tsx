import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { FeatureFlags } from '../../src/config';
import { Colors, Spacing, Radii } from '../../src/theme';

export default function PreferencesScreen() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const developerMode = useSettingsStore((s) => s.developerMode);
  const setDeveloperMode = useSettingsStore((s) => s.setDeveloperMode);

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

        {/* The dev toggle lives HERE, on a plain ScrollView screen, on purpose.
            Builds 50–53 all crashed at launch while a dev control sat inside
            SessionHeader / the session screen's PagerView — the one surface
            that mixes an infinite reanimated loop with screen snapshotting.
            This screen has neither. Don't move the toggle back there. */}
        {FeatureFlags.developerModeAvailable && (
          <>
            <Text style={[styles.sectionHeader, styles.sectionGap]}>DEVELOPER</Text>
            <View style={styles.row}>
              <Text style={styles.rowIcon}>🛠</Text>
              <View style={styles.rowTextCol}>
                <Text style={styles.rowLabel}>Developer mode</Text>
                <Text style={styles.rowHint}>
                  Records this conversation and turns it into build requests that
                  ship automatically.
                </Text>
              </View>
              <Switch
                value={developerMode}
                onValueChange={setDeveloperMode}
                accessibilityLabel="Developer mode"
                trackColor={{ false: Colors.surfaceBorder, true: Colors.coral }}
              />
            </View>
            {developerMode && (
              <TouchableOpacity
                style={styles.row}
                onPress={() => router.push('/dev')}
                activeOpacity={0.7}
              >
                <Text style={styles.rowIcon}>📦</Text>
                <Text style={styles.rowLabel}>Build pipeline (Dev)</Text>
                <Text style={styles.rowChevron}>›</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        <Text style={[styles.sectionHeader, styles.sectionGap]}>APP</Text>
        <View style={styles.row}>
          <Text style={styles.rowIcon}>📱</Text>
          <Text style={styles.rowLabel}>Version</Text>
          <Text style={styles.rowValue}>1.0.0</Text>
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
