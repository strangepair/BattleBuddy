import { View, Text, StyleSheet } from 'react-native';
import { Colors, Radii, Spacing } from '../../theme';

interface MilestoneBadgeProps {
  milestone: string | null;
}

export default function MilestoneBadge({ milestone }: MilestoneBadgeProps) {
  if (!milestone) return null;

  return (
    <View style={styles.pill}>
      <Text style={styles.text}>{'🏆 '}{milestone}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'center',
    backgroundColor: Colors.warning,
    borderRadius: Radii.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  text: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1C1917',
  },
});
