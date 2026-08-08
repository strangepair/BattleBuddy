import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';
import type { ActivityLogEntry, DayBucket } from '../../hooks/useActivityLog';
import {
  layoutDayBlocks,
  dayGridHeight,
  visibleHours,
  entryLabel,
  entryTimestamp,
  fmtHour,
  MINUTE_HEIGHT,
  HOUR_HEIGHT,
  MIN_BLOCK_HEIGHT,
} from './timelineLayout';

const HOUR_LABEL_WIDTH = 56;

interface DayTimelineSectionProps {
  bucket: DayBucket;
  isToday: boolean;
  onPressEntry?: (entry: ActivityLogEntry) => void;
}

function fmtDayHeader(dateStr: string, isToday: boolean): string {
  if (isToday) return 'TODAY';
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * DayTimelineSection renders one day as a fixed-hour time grid (no internal
 * scrolling — the parent inverted FlatList owns the single scroll).
 *
 * Every hour is HOUR_HEIGHT px — a true proportional grid; quiet hours are
 * NOT collapsed. Each logged event is an absolutely positioned block at its
 * minute offset, sized by its real duration when a start+end pair exists and
 * floored at a 5-minute span so instant logs stay visible. Overlapping
 * blocks share horizontal lanes. Past days render all 24 hours; today runs
 * midnight → the NOW line and grows with the minute tick.
 */
export default function DayTimelineSection({ bucket, isToday, onPressEntry }: DayTimelineSectionProps) {
  // Minute tick so today's grid height and NOW line stay current while the
  // dashboard sits open. Past-day sections never re-render from this.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [isToday]);

  const blocks = useMemo(() => layoutDayBlocks(bucket.entries), [bucket.entries]);
  const gridHeight = dayGridHeight(isToday, now);
  const hours = visibleHours(gridHeight);

  return (
    <View style={styles.section}>
      <View style={styles.dayHeader}>
        <Text style={[styles.dayHeaderText, isToday && styles.dayHeaderTextToday]}>
          {fmtDayHeader(bucket.date, isToday)}
        </Text>
        {bucket.entries.length > 0 && (
          <Text style={styles.dayCount}>{bucket.entries.length}</Text>
        )}
      </View>

      <View style={[styles.grid, { height: gridHeight }]}>
        {hours.map((h) => (
          <View key={h} style={[styles.hourRow, { top: h * HOUR_HEIGHT }]} pointerEvents="none">
            <Text style={styles.hourLabel}>{fmtHour(h)}</Text>
            <View style={styles.hourRule} />
          </View>
        ))}

        {/* Blocks live in a layer inset past the hour gutter, so lane
            percentages divide only the plottable width. */}
        <View style={styles.blockLayer}>
          {blocks.map((b) => {
            const ts = entryTimestamp(b.entry);
            const isActivity = b.entry.type === 'activity';
            const laneWidthPct = 100 / b.laneCount;
            const time = ts ? fmtTime(ts) : '';
            return (
              <TouchableOpacity
                key={`${b.entry.type}-${b.entry.id}`}
                style={[
                  styles.block,
                  isActivity ? styles.blockActivity : styles.blockCigarette,
                  {
                    top: b.startMinute * MINUTE_HEIGHT,
                    height: Math.max(b.spanMinutes * MINUTE_HEIGHT, MIN_BLOCK_HEIGHT),
                    left: `${b.lane * laneWidthPct}%` as `${number}%`,
                    width: `${laneWidthPct}%` as `${number}%`,
                  },
                ]}
                activeOpacity={onPressEntry ? 0.7 : 1}
                onPress={onPressEntry ? () => onPressEntry(b.entry) : undefined}
                disabled={!onPressEntry}
              >
                <Text style={styles.blockLabel} numberOfLines={1} ellipsizeMode="tail">
                  {time} · {entryLabel(b.entry)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {isToday && (
          <View style={[styles.nowRow, { top: gridHeight - 1 }]} pointerEvents="none">
            <View style={styles.nowLine} />
            <Text style={styles.nowText}>
              NOW · {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
    paddingBottom: Spacing.sm,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  dayHeaderText: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: Colors.textTertiary,
    flex: 1,
  },
  dayHeaderTextToday: {
    color: Colors.stateIdle,
  },
  dayCount: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textTertiary,
    fontVariant: ['tabular-nums'],
  },
  grid: {
    position: 'relative',
  },
  blockLayer: {
    position: 'absolute',
    left: HOUR_LABEL_WIDTH,
    right: Spacing.xs,
    top: 0,
    bottom: 0,
  },
  hourRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  hourLabel: {
    width: HOUR_LABEL_WIDTH,
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textTertiary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    paddingRight: Spacing.sm,
    lineHeight: 18,
    flexShrink: 0,
  },
  hourRule: {
    flex: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
    marginTop: 5,
  },
  block: {
    position: 'absolute',
    borderRadius: Radii.sm,
    paddingHorizontal: 5,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  blockCigarette: {
    backgroundColor: 'rgba(232,98,74,0.55)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(232,98,74,0.9)',
  },
  blockActivity: {
    backgroundColor: 'rgba(91,159,255,0.35)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(91,159,255,0.7)',
  },
  blockLabel: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  nowRow: {
    position: 'absolute',
    left: HOUR_LABEL_WIDTH,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  nowLine: {
    flex: 1,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(91,159,255,0.7)',
  },
  nowText: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
    color: Colors.stateIdle,
    fontVariant: ['tabular-nums'],
  },
});
