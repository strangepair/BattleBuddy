import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../../theme';
import type { HeatmapData } from '../../services/statsService';

interface HoursHeatmapProps {
  data: HeatmapData;
}

const ROW_LABEL_WIDTH = 34;

// Urges/events by time-of-day x day-of-week — the risk-window model made
// visible ("this is what BB watches for you", doc 08 §5). Cell width is
// flex-based so this scales cleanly across phone sizes.
export default function HoursHeatmap({ data }: HoursHeatmapProps) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={{ width: ROW_LABEL_WIDTH }} />
        {data.colLabels.map((label) => (
          <Text key={label} style={styles.colLabel}>{label}</Text>
        ))}
      </View>
      {data.rowLabels.map((label, ri) => (
        <View key={label} style={styles.row}>
          <Text style={[styles.rowLabel, { width: ROW_LABEL_WIDTH }]}>{label}</Text>
          {data.values[ri].map((v, ci) => (
            <View key={ci} style={[styles.cell, { backgroundColor: hexToRgba(Colors.coral, v) }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  colLabel: {
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textTertiary,
    textAlign: 'center',
  },
  rowLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textTertiary,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 4,
  },
});
