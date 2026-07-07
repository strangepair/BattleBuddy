import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../../theme';
import type { IndependenceWeek } from '../../services/statsService';

interface IndependenceTrendProps {
  weeks: IndependenceWeek[];
}

// Self-initiated vs. prompted engagement, week over week — the mastery
// signal: "more and more, you're catching it yourself" (doc 08 §4/§5).
export default function IndependenceTrend({ weeks }: IndependenceTrendProps) {
  return (
    <View style={styles.card}>
      <View style={styles.bars}>
        {weeks.map((w) => {
          const total = w.selfInitiated + w.prompted;
          const selfPct = total > 0 ? (w.selfInitiated / total) * 100 : 0;
          return (
            <View key={w.label} style={styles.col}>
              <View style={[styles.segment, styles.promptedSegment, { height: `${100 - selfPct}%` }]} />
              <View style={[styles.segment, styles.selfSegment, { height: `${selfPct}%` }]} />
            </View>
          );
        })}
      </View>
      <View style={styles.labels}>
        {weeks.map((w) => (
          <Text key={w.label} style={styles.weekLabel}>{w.label}</Text>
        ))}
      </View>
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: Colors.coral }]} />
          <Text style={styles.legendLabel}>self-initiated</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: Colors.surfaceLight }]} />
          <Text style={styles.legendLabel}>prompted</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    height: 100,
  },
  col: {
    flex: 1,
    flexDirection: 'column-reverse',
    height: '100%',
    borderRadius: 6,
    overflow: 'hidden',
  },
  segment: {
    width: '100%',
  },
  selfSegment: {
    backgroundColor: Colors.coral,
  },
  promptedSegment: {
    backgroundColor: Colors.surfaceLight,
  },
  labels: {
    flexDirection: 'row',
    marginTop: 6,
  },
  weekLabel: {
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textTertiary,
    textAlign: 'center',
  },
  legend: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: 10,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 12.5,
    color: Colors.textTertiary,
  },
});
