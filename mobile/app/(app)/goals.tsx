import { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import type { ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import StatHero from '../../src/components/common/StatHero';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchSessionStats } from '../../src/services/sessionStats';
import { Colors, Spacing, Radii } from '../../src/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

const MILESTONES: { count: number; label: string; icon: IconName }[] = [
  { count: 1, label: 'First resist', icon: 'leaf-outline' },
  { count: 3, label: '3 in a row', icon: 'barbell-outline' },
  { count: 7, label: 'One week', icon: 'star-outline' },
  { count: 14, label: 'Two weeks', icon: 'flame-outline' },
  { count: 30, label: 'One month', icon: 'trophy-outline' },
  { count: 60, label: 'Two months', icon: 'ribbon-outline' },
  { count: 100, label: 'Triple digits', icon: 'diamond-outline' },
];

export default function GoalsScreen() {
  const userId = useAuthStore((s) => s.user?.id);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchSessionStats(userId ?? null)
      .then((s) => { if (!cancelled) setStreak(s.streak); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);

  const next = MILESTONES.find((m) => streak < m.count);

  return (
    <ScreenWithEntity title="Goals">
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.targetCard}>
          <Ionicons name="shield-checkmark-outline" size={28} color={Colors.coral} style={styles.targetIcon} />
          <View style={styles.targetInfo}>
            <Text style={styles.targetTitle}>Quitting smoking</Text>
            <Text style={styles.targetSubtitle}>Your current habit target</Text>
          </View>
        </View>

        <StatHero value={streak} label="resist in a row" pluralLabel="resists in a row" />

        {next && (
          <Text style={styles.nextUp}>
            {streak === 0
              ? 'The first resist is the biggest one — Buddy is ready when the urge hits.'
              : `Next up: ${next.label.toLowerCase()} at ${next.count}. You're ${next.count - streak} away.`}
          </Text>
        )}

        <Text style={styles.sectionTitle}>Milestones</Text>
        {MILESTONES.map(({ count, label, icon }) => {
          const reached = streak >= count;
          return (
            <View key={count} style={[styles.milestone, reached && styles.milestoneReached]}>
              <Ionicons
                name={icon}
                size={22}
                color={reached ? Colors.success : Colors.textSecondary}
                style={[styles.milestoneIcon, !reached && styles.milestoneDim]}
              />
              <View style={styles.milestoneInfo}>
                <Text style={[styles.milestoneLabel, !reached && styles.milestoneDim]}>{label}</Text>
                <Text style={[styles.milestoneCount, !reached && styles.milestoneDim]}>
                  {count} resists
                </Text>
              </View>
              {reached && <Ionicons name="checkmark" size={18} color={Colors.success} />}
            </View>
          );
        })}
      </ScrollView>
    </ScreenWithEntity>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: Spacing.md,
    gap: Spacing.md,
  },
  targetCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.md,
    gap: Spacing.md,
  },
  targetIcon: { width: 32, textAlign: 'center' },
  targetInfo: { flex: 1 },
  targetTitle: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  targetSubtitle: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  nextUp: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: Spacing.md,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginTop: Spacing.xs,
  },
  milestone: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.md,
    gap: Spacing.md,
  },
  milestoneReached: {
    borderWidth: 1,
    borderColor: Colors.success,
  },
  milestoneIcon: { width: 32, textAlign: 'center' },
  milestoneInfo: { flex: 1 },
  milestoneLabel: { fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  milestoneCount: { fontSize: 12, color: Colors.textTertiary, marginTop: 1 },
  milestoneDim: { opacity: 0.35 },
});
