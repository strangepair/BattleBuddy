import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface WorkItemCardProps {
  title: string;
  status: string;
  evidenceCount: number;
  changeRef?: string;
}

export function WorkItemCard({ title, status, evidenceCount, changeRef }: WorkItemCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{status}</Text>
        </View>
      </View>
      <View style={styles.meta}>
        <Text style={styles.metaText}>
          {evidenceCount} submission{evidenceCount === 1 ? '' : 's'}
        </Text>
        {changeRef ? (
          <Text style={styles.changeRef} numberOfLines={1}>{changeRef}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.background,
    borderRadius: Radii.sm,
    padding: Spacing.sm,
    marginBottom: Spacing.xs,
    gap: Spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textPrimary,
    lineHeight: 18,
  },
  badge: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: Radii.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  metaText: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  changeRef: {
    fontSize: 12,
    color: Colors.coral,
    flex: 1,
  },
});
