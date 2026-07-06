import { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import type { ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';
import StatHero from '../../src/components/common/StatHero';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchSessionStats, type SessionStats } from '../../src/services/sessionStats';
import { fetchUserProfile, type UserProfile } from '../../src/services/profileBuilder';
import { Colors, Spacing, Radii, Typography } from '../../src/theme';

export default function AnalyticsScreen() {
  const userId = useAuthStore((s) => s.user?.id);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSessionStats(userId ?? null), fetchUserProfile(userId ?? null)])
      .then(([s, p]) => {
        if (cancelled) return;
        setStats(s);
        setProfile(p);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <ScreenWithEntity title="Analytics">
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : !stats || stats.totalSessions === 0 ? (
        <EmptyState
          icon="pulse-outline"
          title="Your first resist starts the story"
          body="Talk to Buddy through one urge and this screen starts mapping your patterns — when you're strongest, what works, how the streaks build."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <StatHero value={stats.streak} label="resist in a row" pluralLabel="resists in a row" />

          <View style={styles.statsRow}>
            <StatCard label="Sessions" value={String(stats.totalSessions)} />
            <StatCard
              label="Resist rate"
              value={`${stats.resistRate}%`}
              color={stats.resistRate >= 60 ? Colors.success : Colors.warning}
            />
          </View>

          <Text style={styles.sectionTitle}>What works for you</Text>

          {profile?.preferredFraming && (
            <InsightRow icon="locate-outline" text={`You respond best to ${profile.preferredFraming} framing`} />
          )}
          {profile?.hardestTime && (
            <InsightRow icon="alarm-outline" text={`Toughest time: around ${profile.hardestTime}`} />
          )}
          {stats.preferredMode && (
            <InsightRow
              icon={stats.preferredMode === 'voice' ? 'mic-outline' : 'chatbubble-outline'}
              text={`You prefer ${stats.preferredMode} mode`}
            />
          )}
          {!profile?.preferredFraming && !profile?.hardestTime && !stats.preferredMode && (
            <InsightRow icon="trending-up-outline" text="Patterns are forming — a few more sessions and they'll surface here" />
          )}
        </ScrollView>
      )}
    </ScreenWithEntity>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function InsightRow({ icon, text }: { icon: ComponentProps<typeof Ionicons>['name']; text: string }) {
  return (
    <View style={styles.insightRow}>
      <Ionicons name={icon} size={20} color={Colors.textSecondary} style={styles.insightIcon} />
      <Text style={styles.insightText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    padding: Spacing.md,
    gap: Spacing.md,
  },
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  statValue: {
    ...Typography.statValue,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  insightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    gap: Spacing.md,
  },
  insightIcon: {
    width: 28,
    textAlign: 'center',
  },
  insightText: {
    flex: 1,
    fontSize: 14,
    color: Colors.textPrimary,
    lineHeight: 20,
  },
});
