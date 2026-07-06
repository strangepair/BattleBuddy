import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii, Typography } from '../../theme';

interface StatHeroProps {
  value: number;
  /** Singular label, e.g. "resist in a row" — pluralized automatically. */
  label: string;
  pluralLabel?: string;
}

// One streak hero shared by Analytics and Goals — previously the same
// coral-bordered "0" card existed twice with different vocabulary
// ("resist streak" vs "resists in a row") and two numeral scales.
// "Resists in a row" is the one term; formatCount handles the plural.
export default function StatHero({ value, label, pluralLabel }: StatHeroProps) {
  const text = value === 1 ? label : pluralLabel ?? `${label}s`;

  return (
    <View style={styles.card}>
      <Text style={styles.number}>{value}</Text>
      <Text style={styles.label}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    paddingVertical: Spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.coral,
  },
  number: {
    ...Typography.statHero,
    fontVariant: ['tabular-nums'],
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginTop: 4,
  },
});
