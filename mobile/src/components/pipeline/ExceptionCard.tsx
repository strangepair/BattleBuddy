import { StyleSheet, Text, View } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface Props {
  title: string;
  body: string;
  defaultAction: string;
  deadlineIso: string;
}

export function ExceptionCard({ title, body, defaultAction, deadlineIso }: Props) {
  const deadlineStr = formatDeadline(deadlineIso);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>NEEDS INPUT</Text>
        </View>
        <Text style={styles.deadline}>By {deadlineStr}</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <View style={styles.defaultRow}>
        <Text style={styles.defaultLabel}>Default if no response: </Text>
        <Text style={styles.defaultAction}>{defaultAction}</Text>
      </View>
    </View>
  );
}

function formatDeadline(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderWidth: 2,
    borderColor: Colors.warning,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badge: {
    backgroundColor: Colors.warning,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#000',
    letterSpacing: 0.5,
  },
  deadline: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.warning,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
    lineHeight: 20,
  },
  body: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  defaultRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
    paddingTop: Spacing.sm,
  },
  defaultLabel: {
    fontSize: 12,
    color: Colors.textTertiary,
    fontStyle: 'italic',
  },
  defaultAction: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '600',
    fontStyle: 'italic',
    flex: 1,
  },
});
