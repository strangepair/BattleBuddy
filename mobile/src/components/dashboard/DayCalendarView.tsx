import { useRef, useEffect } from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../../theme';
import ActualsLayer from './ActualsLayer';
import type { SmokingLog } from '../../hooks/useSmokingLogs';

export interface DayLog {
  date: string;
  logs: SmokingLog[];
}

interface DayCalendarViewProps {
  /** Today's actual cigarette log entries. */
  actuals: SmokingLog[];
  /** Up to 3 previous days' logs rendered as ghost/faded markers. */
  previousDays?: DayLog[];
  /** Called when the user taps a non-ghost log block. */
  onPressLog?: (log: SmokingLog) => void;
  [key: string]: unknown;
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

/**
 * DayCalendarView renders a vertically scrollable minute-level 24-hour timeline.
 *
 * Each minute is a distinct slot (MINUTE_HEIGHT px tall). Hour labels appear
 * at the top of each hour row. On mount the view scrolls to the current time.
 * Calendar items are rendered as absolutely-positioned time-blocks whose height
 * corresponds to their duration. Overlapping items are offset horizontally.
 *
 * @param actuals - Today's SmokingLog entries from useSmokingLogs.
 * @param previousDays - Optional array of DayLog for the previous 1–3 days.
 */
export default function DayCalendarView({ actuals, previousDays = [], onPressLog }: DayCalendarViewProps) {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const now = new Date();
    const offset = minuteOffset(now.getHours(), now.getMinutes());
    const scrollTo = Math.max(0, offset - 80);
    scrollRef.current?.scrollTo({ y: scrollTo, animated: false });
  }, []);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const nowHour = new Date().getHours();
  const nowMinute = new Date().getMinutes();
  const nowOffset = minuteOffset(nowHour, nowMinute);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={true}
    >
      <Text style={styles.sectionLabel}>TODAY'S TIMELINE</Text>
      <View style={[styles.timeline, { height: TOTAL_MINUTES * MINUTE_HEIGHT }]}>
        {hours.map((hour) => {
          const isNowHour = hour === nowHour;
          const hourTop = minuteOffset(hour, 0);

          return (
            <View key={hour} style={[styles.hourBlock, { top: hourTop }]}>
              <Text style={[styles.hourLabel, isNowHour && styles.hourLabelNow]}>
                {fmtHour(hour)}
              </Text>
              <View style={styles.hourBody} />
            </View>
          );
        })}

        <View
          style={[styles.nowLine, { top: nowOffset }]}
          pointerEvents="none"
        />

        {previousDays.slice(0, 3).map((day, idx) => (
          <ActualsLayer
            key={day.date}
            logs={day.logs}
            ghost
            timelineLeft={HOUR_LABEL_WIDTH}
            ghostIndex={idx}
          />
        ))}

        <ActualsLayer
          logs={actuals}
          ghost={false}
          timelineLeft={HOUR_LABEL_WIDTH}
          onPressLog={onPressLog}
        />
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
    position: 'relative',
  },
  hourBlock: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 60 * MINUTE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-start',
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
    paddingTop: 1,
  },
  hourLabelNow: {
    color: Colors.stateIdle,
  },
  hourBody: {
    flex: 1,
    height: 60 * MINUTE_HEIGHT,
    position: 'relative',
    overflow: 'hidden',
  },
  nowLine: {
    position: 'absolute',
    left: HOUR_LABEL_WIDTH,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(91,159,255,0.6)',
  },
});
