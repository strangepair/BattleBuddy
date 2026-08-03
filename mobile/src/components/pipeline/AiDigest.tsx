import { StyleSheet, Text, View } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface Props {
  digest: string | null;
}

export function AiDigest({ digest }: Props) {
  if (!digest) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>AI DIGEST</Text>
      <Text style={styles.body}>{digest}</Text>
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
    color: Colors.coral,
    letterSpacing: 1.2,
  },
  body: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
});
