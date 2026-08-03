import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface AiDigestProps {
  digest: string | null | undefined;
}

export function AiDigest({ digest }: AiDigestProps) {
  if (!digest) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.label}>PIPELINE SUMMARY</Text>
      <Text style={styles.text}>{digest}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.coral,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.xs,
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textTertiary,
    letterSpacing: 1,
  },
  text: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
});
