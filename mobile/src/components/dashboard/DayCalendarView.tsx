import { useRef, useEffect } from 'react';
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

const MINUTE_HEIGHT = 2;
const TOTAL_MINUTES = 24 * 60;
const HOUR_LABEL_WIDTH = 52;

function fmtHour(h: number): string {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:00`;
}

function minuteOffset(hour: number, minute: number): number {
  return (hour * 60 + minute) * MINUTE_HEIGHT;
}

function logsForMinute(logs: SmokingLog[], hour: number, minute: number): SmokingLog[] {
  return logs.filter((l) => {
    const d = new Date(l.occurred_at);
    return d.getHours() === hour && d.getMinutes() === minute;
  });
}

/**
 * DayCalendarView renders a vertically scrollable minute-level 24-hour timeline.
 *
 * Each minute is a distinct slot (MINUTE_HEIGHT px tall). Hour labels appear
 * at the top of each hour row. On mount the view scrolls to the current time.
 *
 * @param projected - Per-hour average counts (0–23) from useRoutineProjection.
 * @param actuals - Today's SmokingLog entries from useSmokingLogs.
 * @param previousDays - Optional array of DayLog for the previous 1–3 days.
 */
export default function DayCalendarView({ projected, actuals, previousDays = [] }: DayCalendarViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const maxAvg = Math.max(...projected.map((s) => s.avgCount), 0);

  useEffect(() => {
    const now = new Date();
    const offset = minuteOffset(now.getHours(), now.getMinutes());
    const scrollTo = Math.max(0, offset - 80);
    scrollRef.current?.scrollTo({ y: scrollTo, animated: false });
  }, []);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const nowHour = new Date().getHours();
  const nowMinute = new Date().getMinutes();

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={true}
    >
      <Text style={styles.sectionLabel}>TODAY'S TIMELINE</Text>
      <View style={styles.timeline}>
        {hours.map((hour) => {
          const slot = projected[hour];
          const isNowHour = hour === nowHour;

          return (
            <View key={hour} style={styles.hourBlock}>
              {Array.from({ length: 60 }, (_, minute) => {
                const isNow = isNowHour && minute === nowMinute;
                const todayActuals = logsForMinute(actuals, hour, minute);
                const hasActuals = todayActuals.length > 0;
                const hasGhosts = previousDays.some((d) =>
                  logsForMinute(d.logs, hour, minute).length > 0
                );

                return (
                  <View
                    key={minute}
                    style={[
                      styles.minuteRow,
                      isNow && styles.minuteRowNow,
                    ]}
                  >
                    {minute === 0 && (
                      <Text style={[styles.hourLabel, isNowHour && styles.hourLabelNow]}>
                        {fmtHour(hour)}
                      </Text>
                    )}
                    {minute !== 0 && <View style={styles.hourLabelSpacer} />}
                    <View style={styles.minuteBody}>
                      {minute === 0 && slot && (
                        <ProjectedRoutineLayer projected={[slot]} maxAvg={maxAvg} />
                      )}
                      {hasGhosts &&
                        previousDays.slice(0, 3).map((day) => {
                          const ghostLogs = logsForMinute(day.logs, hour, minute);
                          return ghostLogs.length > 0 ? (
                            <ActualsLayer key={day.date} logs={ghostLogs} ghost />
                          ) : null;
                        })}
                      {hasActuals && <ActualsLayer logs={todayActuals} />}
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>
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
  timeline: {
    minHeight: TOTAL_MINUTES * MINUTE_HEIGHT,
  },
  hourBlock: {
    flexDirection: 'column',
  },
  minuteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: MINUTE_HEIGHT,
    borderBottomWidth: 0,
  },
  minuteRowNow: {
    backgroundColor: 'rgba(91,159,255,0.25)',
  },
  hourLabel: {
    width: HOUR_LABEL_WIDTH,
    fontSize: 9,
    fontWeight: '600',
    color: Colors.textTertiary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    paddingRight: Spacing.sm,
    flexShrink: 0,
    lineHeight: 10,
  },
  hourLabelNow: {
    color: Colors.stateIdle,
  },
  hourLabelSpacer: {
    width: HOUR_LABEL_WIDTH,
    flexShrink: 0,
  },
  minuteBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    position: 'relative',
    overflow: 'hidden',
    borderRadius: Radii.sm,
  },
});
