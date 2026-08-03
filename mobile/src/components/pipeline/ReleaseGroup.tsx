import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface ReleaseGroupProps {
  releaseLabel: string;
  releasedAt: string;
  children: React.ReactNode;
}

export function ReleaseGroup({ releaseLabel, releasedAt, children }: ReleaseGroupProps) {
  const date = new Date(releasedAt);
  const formatted = isNaN(date.getTime())
    ? releasedAt
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <View style={styles.group}>
      <View style={styles.header}>
        <Text style={styles.label}>{releaseLabel}</Text>
        <Text style={styles.date}>{formatted}</Text>
      </View>
      <View style={styles.items}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  date: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  items: {
    padding: Spacing.sm,
  },
});
