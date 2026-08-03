import { useRef, useEffect, useState, useCallback } from 'react';
import { ScrollView, View, Text, StyleSheet, Pressable } from 'react-native';
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
  /** Called when the user taps a non-ghost log block. */
  onPressLog?: (log: SmokingLog) => void;
  /** Called when the user taps a projected routine block. */
  onPressSlot?: (slot: HourSlot) => void;
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

function getNowScrollTarget(): number {
  const now = new Date();
  return Math.max(0, minuteOffset(now.getHours(), now.getMinutes()) - 80);
}

/**
 * DayCalendarView renders a vertically scrollable minute-level 24-hour timeline.
 *
 * Each minute is a distinct slot (MINUTE_HEIGHT px tall). Hour labels appear
 * at the top of each hour row. On mount the view scrolls to the current time.
 * Calendar items are rendered as absolutely-positioned time-blocks whose height
 * corresponds to their duration. Overlapping items are offset horizontally.
 *
 * @param projected - Per-hour average counts (0–23) from useRoutineProjection.
 * @param actuals - Today's SmokingLog entries from useSmokingLogs.
 * @param previousDays - Optional array of DayLog for the previous 1–3 days.
 */
export default function DayCalendarView({ projected, actuals, previousDays = [], onPressLog, onPressSlot }: DayCalendarViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const [scrollY, setScrollY] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const maxAvg = Math.max(...projected.map((s) => s.avgCount), 0);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: getNowScrollTarget(), animated: false });
  }, []);

  const handleScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number } } }) => {
    setScrollY(e.nativeEvent.contentOffset.y);
  }, []);

  const handleLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    setViewportHeight(e.nativeEvent.layout.height);
  }, []);

  const jumpToNow = useCallback(() => {
    scrollRef.current?.scrollTo({ y: getNowScrollTarget(), animated: true });
  }, []);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const nowHour = new Date().getHours();
  const nowMinute = new Date().getMinutes();
  const nowOffset = minuteOffset(nowHour, nowMinute);

  const nowVisible = viewportHeight > 0 && nowOffset >= scrollY && nowOffset <= scrollY + viewportHeight;
  const showJumpToNow = !nowVisible;

  return (
    <View style={styles.wrapper} onLayout={handleLayout}>
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={true}
      onScroll={handleScroll}
      scrollEventThrottle={100}
    >
      <Text style={styles.sectionLabel}>TODAY'S TIMELINE</Text>
      <View style={[styles.timeline, { height: TOTAL_MINUTES * MINUTE_HEIGHT }]}>
        {hours.map((hour) => {
          const slot = projected[hour];
          const isNowHour = hour === nowHour;
          const hourTop = minuteOffset(hour, 0);

          return (
            <View key={hour} style={[styles.hourBlock, { top: hourTop }]}>
              <Text style={[styles.hourLabel, isNowHour && styles.hourLabelNow]}>
                {fmtHour(hour)}
              </Text>
              <View style={styles.hourBody}>
                {slot && maxAvg > 0 && slot.avgCount > 0 && (
                  <ProjectedRoutineLayer projected={[slot]} maxAvg={maxAvg} onPress={onPressSlot} />
                )}
              </View>
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
    {showJumpToNow && (
      <Pressable
        style={styles.jumpToNowBtn}
        onPress={jumpToNow}
        accessibilityLabel="Jump to now"
        accessibilityRole="button"
      >
        <Text style={styles.jumpToNowText}>Now</Text>
      </Pressable>
    )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    position: 'relative',
  },
  scroll: {
    flex: 1,
  },
  jumpToNowBtn: {
    position: 'absolute',
    bottom: Spacing.md,
    right: Spacing.md,
    backgroundColor: Colors.stateIdle,
    borderRadius: Radii.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  jumpToNowText: {
    color: Colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
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
