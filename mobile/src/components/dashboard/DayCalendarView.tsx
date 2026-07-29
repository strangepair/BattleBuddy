import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';
import ProjectedRoutineLayer from './ProjectedRoutineLayer';
import ActualsLayer from './ActualsLayer';
import type { HourSlot } from '../../hooks/useRoutineProjection';
import type { SmokingLog } from '../../hooks/useSmokingLogs';

export interface DayLog {
  date: string;
  logs: SmokingLog[];
}

interface DayCalendarViewProps {
  /** Per-hour projected averages from the user's historical routine. */
  projected: HourSlot[];
  /** Today's actual cigarette log entries. */
  actuals: SmokingLog[];
  /** Up to 3 previous days' logs rendered as ghost/faded markers. */
  previousDays?: DayLog[];
}

const WAKING_START = 5;
const WAKING_END = 23;

function fmtHour(h: number): string {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${suffix}`;
}

function logsForHour(logs: SmokingLog[], hour: number): SmokingLog[] {
  return logs.filter((l) => new Date(l.occurred_at).getHours() === hour);
}

/**
 * DayCalendarView renders a vertically scrollable hour-by-hour timeline
 * spanning waking hours (05:00–23:00).
 *
 * Each row shows:
 *  - A `ProjectedRoutineLayer` — historical average frequency as a subtle bar.
 *  - An `ActualsLayer` — today's actual logged events as coloured dots.
 *  - Ghost markers from up to 3 previous days (faded, for trend comparison).
 *
 * @param projected - Per-hour average counts (0–23) from useRoutineProjection.
 * @param actuals - Today's SmokingLog entries from useSmokingLogs.
 * @param previousDays - Optional array of DayLog for the previous 1–3 days.
 */
export default function DayCalendarView({ projected, actuals, previousDays = [] }: DayCalendarViewProps) {
  const maxAvg = Math.max(...projected.map((s) => s.avgCount), 0);
  const hours = Array.from({ length: WAKING_END - WAKING_START + 1 }, (_, i) => WAKING_START + i);
  const nowHour = new Date().getHours();

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.sectionLabel}>TODAY'S TIMELINE</Text>
      {hours.map((hour) => {
        const slot = projected[hour];
        const todayActuals = logsForHour(actuals, hour);
        const isNow = hour === nowHour;

        return (
          <View key={hour} style={[styles.row, isNow && styles.rowNow]}>
            <Text style={[styles.hourLabel, isNow && styles.hourLabelNow]}>{fmtHour(hour)}</Text>
            <View style={styles.rowBody}>
              {slot && <ProjectedRoutineLayer projected={[slot]} maxAvg={maxAvg} />}
              {previousDays.slice(0, 3).map((day) => {
                const ghostLogs = logsForHour(day.logs, hour);
                return (
                  <ActualsLayer key={day.date} logs={ghostLogs} ghost />
                );
              })}
              <ActualsLayer logs={todayActuals} />
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    paddingBottom: Spacing.lg,
  },
  sectionLabel: {
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: '800',
    color: Colors.textTertiary,
    marginBottom: Spacing.sm,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 36,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
    paddingVertical: 5,
  },
  rowNow: {
    backgroundColor: 'rgba(91,159,255,0.06)',
  },
  hourLabel: {
    width: 52,
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textTertiary,
    paddingTop: 2,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    paddingRight: Spacing.sm,
    flexShrink: 0,
  },
  hourLabelNow: {
    color: Colors.stateIdle,
  },
  rowBody: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
    position: 'relative',
    minHeight: 26,
    borderRadius: Radii.sm,
    overflow: 'hidden',
  },
});
