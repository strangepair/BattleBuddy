import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, Radii } from '../../theme';

interface SessionCardProps {
  startedAt: string;
  mode: string;
  outcome: string | null;
  helped: boolean | null;
  intensityStart: number | null;
  intensityEnd: number | null;
  onPress: () => void;
}

const OUTCOME_LABELS: Record<string, { text: string; color: string }> = {
  resisted: { text: 'Resisted', color: Colors.success },
  submitted: { text: 'Slipped', color: Colors.warning },
  unsure: { text: 'Unsure', color: Colors.textSecondary },
};

export default function SessionCard({
  startedAt,
  mode,
  outcome,
  helped,
  intensityStart,
  intensityEnd,
  onPress,
}: SessionCardProps) {
  const date = new Date(startedAt);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const outcomeInfo = outcome ? OUTCOME_LABELS[outcome] : null;

  const intensityDrop =
    intensityStart != null && intensityEnd != null
      ? intensityStart - intensityEnd
      : null;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.left}>
        <Text style={styles.date}>{dateStr}</Text>
        <Text style={styles.time}>{timeStr}</Text>
      </View>

      <View style={styles.center}>
        <View style={styles.badges}>
          <Ionicons
            name={mode === 'voice' ? 'mic-outline' : 'chatbubble-outline'}
            size={14}
            color={Colors.textSecondary}
            style={styles.modeBadge}
          />
          {outcomeInfo && (
            <Text style={[styles.outcomeBadge, { color: outcomeInfo.color }]}>
              {outcomeInfo.text}
            </Text>
          )}
        </View>
        {intensityDrop != null && intensityDrop > 0 && (
          <Text style={styles.intensity}>↓{intensityDrop} intensity</Text>
        )}
        {helped != null && (
          <Text style={styles.helped}>{helped ? 'Helped' : 'Not helpful'}</Text>
        )}
      </View>

      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.md,
    gap: Spacing.md,
  },
  left: {
    alignItems: 'center',
    minWidth: 50,
  },
  date: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  time: {
    fontSize: 11,
    color: Colors.textTertiary,
  },
  center: {
    flex: 1,
    gap: 2,
  },
  badges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  modeBadge: {
    fontSize: 16,
  },
  outcomeBadge: {
    fontSize: 14,
    fontWeight: '600',
  },
  intensity: {
    fontSize: 12,
    color: Colors.success,
  },
  helped: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  chevron: {
    fontSize: 20,
    color: Colors.textTertiary,
    fontWeight: '300',
  },
});
