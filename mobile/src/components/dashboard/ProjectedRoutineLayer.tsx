import { View, StyleSheet } from 'react-native';
import { Colors } from '../../theme';
import type { HourSlot } from '../../hooks/useRoutineProjection';

interface ProjectedRoutineLayerProps {
  /** Per-hour average cigarette counts derived from the past 14 days. */
  projected: HourSlot[];
  /** Max avgCount across all slots — used to normalise bar widths. */
  maxAvg: number;
}

/**
 * ProjectedRoutineLayer renders a subtle horizontal bar inside an hour row
 * indicating the user's historical average cigarette frequency for that hour.
 * Bars are proportionally scaled relative to the peak hour.
 */
export default function ProjectedRoutineLayer({ projected, maxAvg }: ProjectedRoutineLayerProps) {
  const slot = projected[0];
  if (!slot || maxAvg === 0 || slot.avgCount === 0) return null;

  const widthPct = Math.min(1, slot.avgCount / maxAvg);

  return (
    <View style={styles.track}>
      <View style={[styles.bar, { width: `${Math.round(widthPct * 100)}%` as `${number}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  bar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.stateIdle,
    opacity: 0.28,
  },
});
