import { useEffect, useState } from 'react';
import { Text, View, StyleSheet, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import HomeButton from '../../src/components/common/HomeButton';
import EdgeEntrance from '../../src/components/common/EdgeEntrance';
import EntityBackground from '../../src/components/home/EntityBackground';
import StatHero from '../../src/components/common/StatHero';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchSessionStats, formatCount, type SessionStats } from '../../src/services/sessionStats';
import { fetchUserProfile } from '../../src/services/profileBuilder';
import { Colors, Spacing, Radii, Typography } from '../../src/theme';

// Profile v1 — the right-swipe destination is no longer a dead end: who you
// are, where the journey stands, and the door to settings. Numbers come from
// the shared sessionStats selector, so they can never disagree with
// History/Analytics.
export default function ProfileScreen() {
  const user = useAuthStore((s) => s.user);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [journeyLine, setJourneyLine] = useState<string | null>(null);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    let cancelled = false;
    fetchSessionStats(user?.id ?? null).then((s) => { if (!cancelled) setStats(s); }).catch(() => {});
    fetchUserProfile(user?.id ?? null).then((p) => {
      if (cancelled) return;
      // First sentences of the living profile read as the journey line.
      const first = p.summary.split('. ').slice(0, 2).join('. ');
      if (first && !first.includes('New user')) setJourneyLine(first);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id]);

  return (
    <EdgeEntrance edge="right">
      <View style={styles.root}>
        <EntityBackground
          targetColor={Colors.stateIdle}
          energy={0.05}
          center={{ x: width / 2, y: height * 0.22 }}
        />
        <HomeButton />
        <SafeAreaView style={styles.container}>
          <View style={styles.identity}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(user?.name || 'B')[0].toUpperCase()}</Text>
            </View>
            <Text style={styles.name}>{user?.name || 'Battle Buddy'}</Text>
            {journeyLine && <Text style={styles.journey}>{journeyLine}</Text>}
          </View>

          <StatHero value={stats?.streak ?? 0} label="resist in a row" pluralLabel="resists in a row" />

          <View style={styles.metaRow}>
            <View style={styles.metaCard}>
              <Text style={styles.metaValue}>{stats?.totalSessions ?? '—'}</Text>
              <Text style={styles.metaLabel}>{formatCount(stats?.totalSessions ?? 0, 'session')}</Text>
            </View>
            <View style={styles.metaCard}>
              <Text style={styles.metaValue}>{stats ? `${stats.resistRate}%` : '—'}</Text>
              <Text style={styles.metaLabel}>resist rate</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.settingsRow} onPress={() => router.push('/preferences')} activeOpacity={0.7}>
            <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
            <Text style={styles.settingsText}>Settings & notifications</Text>
            <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
          </TouchableOpacity>
        </SafeAreaView>
      </View>
    </EdgeEntrance>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xxl,
    gap: Spacing.lg,
  },
  identity: {
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: Spacing.md,
  },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Colors.surface,
    borderWidth: 2,
    borderColor: Colors.coral,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  avatarText: {
    fontSize: 34,
    fontWeight: '800',
    color: Colors.coral,
  },
  name: {
    ...Typography.screenTitle,
    fontSize: 22,
  },
  journey: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: Spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  metaCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    gap: 2,
  },
  metaValue: {
    ...Typography.statValue,
  },
  metaLabel: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    marginTop: 'auto',
    marginBottom: Spacing.xl,
  },
  settingsText: {
    flex: 1,
    fontSize: 15,
    color: Colors.textPrimary,
  },
});
