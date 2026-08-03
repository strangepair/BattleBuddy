import { StyleSheet, Text, View } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface Props {
  title: string;
  status: string;
  evidenceCount: number;
  changeRef?: string;
}

export function WorkItemCard({ title, status, evidenceCount, changeRef }: Props) {
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
    borderRadius: Radii.md,
    padding: Spacing.sm,
    marginBottom: Spacing.xs,
    gap: Spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.surfaceBorder,
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
    lineHeight: 19,
  },
  badge: {
    backgroundColor: Colors.surface,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textSecondary,
    textTransform: 'capitalize',
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
