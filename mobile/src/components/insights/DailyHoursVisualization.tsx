import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../../theme';
import type { ScheduleWindow } from '../../types/resistanceBlocks';

interface DailyHoursVisualizationProps {
  scheduleWindows?: ScheduleWindow[];
}

const WINDOW_TINT = 'rgba(99,102,241,0.08)';
const LEGEND_COLOR = 'rgba(99,102,241,1)';

function hourInWindow(hour: number, windows: ScheduleWindow[]): boolean {
  for (const w of windows) {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    const startMins = sh * 60 + (sm ?? 0);
    const endMins = eh * 60 + (em ?? 0);
    const hourMins = hour * 60;
    if (hourMins >= startMins && hourMins < endMins) return true;
  }
  return false;
}

export default function DailyHoursVisualization({ scheduleWindows }: DailyHoursVisualizationProps) {
  const hasWindows = scheduleWindows !== undefined && scheduleWindows.length > 0;

  return (
    <View style={styles.container}>
      {Array.from({ length: 24 }, (_, i) => i).map((hour) => {
        const tinted = hasWindows && hourInWindow(hour, scheduleWindows!);
        const label = `${hour.toString().padStart(2, '0')}:00`;
        return (
          <View
            key={hour}
            style={[styles.hourRow, tinted && styles.hourRowTinted]}
          >
            <Text style={styles.hourLabel}>{label}</Text>
          </View>
        );
      })}
      {hasWindows && (
        <View style={styles.legend}>
          <View style={styles.legendSwatch} />
          <Text style={styles.legendText}>Primary resistance window</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
  },
  hourRow: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  hourRowTinted: {
    backgroundColor: WINDOW_TINT,
  },
  hourLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textTertiary,
    fontVariant: ['tabular-nums'],
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  legendSwatch: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: LEGEND_COLOR,
  },
  legendText: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
});
