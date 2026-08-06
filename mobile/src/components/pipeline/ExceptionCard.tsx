import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface ExceptionCardProps {
  title: string;
  body: string;
  defaultAction: string;
  deadlineIso: string;
}

function formatDeadline(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ExceptionCard({ title, body, defaultAction, deadlineIso }: ExceptionCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <View style={styles.warningDot} />
        <Text style={styles.title}>{title}</Text>
      </View>
      <Text style={styles.body}>{body}</Text>
      <View style={styles.divider} />
      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Default action</Text>
        <Text style={styles.metaValue}>{defaultAction}</Text>
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Deadline</Text>
        <Text style={styles.metaValue}>{formatDeadline(deadlineIso)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderWidth: 1.5,
    borderColor: Colors.warning,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  warningDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.warning,
  },
  title: {
    flex: 1,
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
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.surfaceBorder,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  metaLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.warning,
    minWidth: 100,
    flexShrink: 0,
  },
  metaValue: {
    flex: 1,
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 16,
  },
});
