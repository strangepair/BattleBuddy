import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors } from '../../theme';
import type { HourSlot } from '../../hooks/useRoutineProjection';

interface ProjectedRoutineLayerProps {
  /** Per-hour average cigarette counts derived from the past 14 days. */
  projected: HourSlot[];
  /** Max avgCount across all slots — used to normalise bar widths. */
  maxAvg: number;
  /** Called when the user taps a projected routine block. */
  onPress?: (slot: HourSlot) => void;
}

/**
 * ProjectedRoutineLayer renders a subtle horizontal bar inside an hour row
 * indicating the user's historical average cigarette frequency for that hour.
 * Bars are proportionally scaled relative to the peak hour.
 */
export default function ProjectedRoutineLayer({ projected, maxAvg, onPress }: ProjectedRoutineLayerProps) {
  const slot = projected[0];
  if (!slot || maxAvg === 0 || slot.avgCount === 0) return null;

  const widthPct = Math.min(1, slot.avgCount / maxAvg);
  const label = `~${slot.avgCount.toFixed(1)} avg`;

  const bar = (
    <View style={styles.track}>
      <View style={[styles.bar, { width: `${Math.round(widthPct * 100)}%` as `${number}%` }]}>
        <Text style={styles.label} numberOfLines={1} ellipsizeMode="tail">
          {label}
        </Text>
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity style={styles.touchable} onPress={() => onPress(slot)} activeOpacity={0.7}>
        {bar}
      </TouchableOpacity>
    );
  }

  return bar;
}

const styles = StyleSheet.create({
  touchable: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
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
    height: 20,
    borderRadius: 3,
    backgroundColor: Colors.stateIdle,
    opacity: 0.5,
    justifyContent: 'center',
    paddingHorizontal: 5,
    overflow: 'hidden',
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
});
