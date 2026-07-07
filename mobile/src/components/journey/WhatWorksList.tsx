import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../../theme';
import type { WorksItem } from '../../services/statsService';

interface WhatWorksListProps {
  items: WorksItem[];
}

// Coping strategies ranked by observed success rate — "the scientist's
// gift to the user" (doc 08 §5), not a raw percentage with no meaning.
export default function WhatWorksList({ items }: WhatWorksListProps) {
  return (
    <View style={styles.card}>
      {items.map((item) => (
        <View key={item.name} style={styles.row}>
          <View style={styles.top}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.ratio}>{item.succeeded} of {item.total}</Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${(item.succeeded / item.total) * 100}%` }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
    gap: 14,
  },
  row: {
    gap: 5,
  },
  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  ratio: {
    fontSize: 15,
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 9,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 9,
    backgroundColor: Colors.coral,
  },
});
