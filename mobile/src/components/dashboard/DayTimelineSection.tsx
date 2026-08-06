import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';
import type { ActivityLogEntry, DayBucket } from '../../hooks/useActivityLog';
import {
  buildTimelineRows,
  entryLabel,
  entryTimestamp,
  fmtHour,
  fmtGapLabel,
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

function EntryBlock({ entry, onPress }: { entry: ActivityLogEntry; onPress?: (e: ActivityLogEntry) => void }) {
  const ts = entryTimestamp(entry);
  const isActivity = entry.type === 'activity';
  const endTs = isActivity ? entry.end_time : (entry.metadata?.end_time as string | undefined);
  const time = ts ? fmtTime(ts) : '';
  const timeRange = endTs ? `${time} – ${fmtTime(endTs)}` : time;

  return (
    <TouchableOpacity
      style={[styles.entryBlock, isActivity ? styles.entryBlockActivity : styles.entryBlockCigarette]}
      activeOpacity={onPress ? 0.7 : 1}
      onPress={onPress ? () => onPress(entry) : undefined}
      disabled={!onPress}
    >
      <View style={[styles.entryDot, isActivity && styles.entryDotActivity]} />
      <Text style={styles.entryTime}>{timeRange}</Text>
      <Text style={styles.entryLabel} numberOfLines={1} ellipsizeMode="tail">
        {entryLabel(entry)}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * DayTimelineSection renders one day of the mission timeline as flat content
 * (no internal scrolling — the parent FlatList owns the single scroll).
 *
 * Layout: a day header, then hour rows for every hour that has entries, with
 * runs of empty hours collapsed into slim gap dividers. Today's section spans
 * from the morning (or first entry) through the current hour and closes with
 * a NOW marker; past days span only their own entries. Days with no entries
 * render one slim empty row — never placeholder blocks.
 */
export default function DayTimelineSection({ bucket, isToday, onPressEntry }: DayTimelineSectionProps) {
  // Minute tick so today's NOW marker and hour span stay current while the
  // dashboard sits open. Past-day sections never re-render from this.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [isToday]);

  const rows = buildTimelineRows(bucket.entries, isToday, now);
  const count = bucket.entries.length;

  return (
    <View style={styles.section}>
      <View style={[styles.dayHeader, isToday && styles.dayHeaderToday]}>
        <Text style={[styles.dayHeaderText, isToday && styles.dayHeaderTextToday]}>
          {fmtDayHeader(bucket.date, isToday)}
        </Text>
        {count > 0 && <Text style={styles.dayCount}>{count}</Text>}
      </View>

      {rows.length === 0 ? (
        <View style={styles.emptyRow}>
          <Text style={styles.emptyText}>
            {isToday ? 'Nothing logged yet today' : '—'}
          </Text>
        </View>
      ) : (
        rows.map((row) =>
          row.kind === 'gap' ? (
            <View key={`gap-${row.fromHour}`} style={styles.gapRow}>
              <Text style={styles.gapLabel}>{fmtGapLabel(row.fromHour, row.toHour)}</Text>
              <View style={styles.gapRule} />
            </View>
          ) : (
            <View key={`hour-${row.hour}`} style={styles.hourRow}>
              <Text style={styles.hourLabel}>{fmtHour(row.hour)}</Text>
              <View style={styles.hourEntries}>
                {row.entries.map((entry) => (
                  <EntryBlock key={`${entry.type}-${entry.id}`} entry={entry} onPress={onPressEntry} />
                ))}
              </View>
            </View>
          ),
        )
      )}

      {isToday && (
        <View style={styles.nowRow}>
          <View style={styles.nowLine} />
          <Text style={styles.nowText}>
            NOW · {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </Text>
        </View>
      )}
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
  dayHeaderToday: {},
  dayHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: Colors.textTertiary,
    flex: 1,
  },
  dayHeaderTextToday: {
    color: Colors.stateIdle,
  },
  dayCount: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textTertiary,
    fontVariant: ['tabular-nums'],
  },
  emptyRow: {
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.sm,
  },
  emptyText: {
    fontSize: 13,
    color: Colors.textTertiary,
    marginLeft: HOUR_LABEL_WIDTH,
  },
  hourRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  hourLabel: {
    width: HOUR_LABEL_WIDTH,
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    paddingRight: Spacing.sm,
    paddingTop: 8,
    flexShrink: 0,
  },
  hourEntries: {
    flex: 1,
    gap: 4,
  },
  entryBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radii.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 7,
    gap: Spacing.sm,
  },
  entryBlockCigarette: {
    backgroundColor: 'rgba(232,98,74,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(232,98,74,0.35)',
  },
  entryBlockActivity: {
    backgroundColor: 'rgba(91,159,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(91,159,255,0.28)',
  },
  entryDot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
    backgroundColor: Colors.coral,
    flexShrink: 0,
  },
  entryDotActivity: {
    backgroundColor: Colors.stateIdle,
  },
  entryTime: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  entryLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textPrimary,
    flex: 1,
  },
  gapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    height: 26,
  },
  gapLabel: {
    width: HOUR_LABEL_WIDTH + 40,
    fontSize: 10,
    color: Colors.textTertiary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    paddingRight: Spacing.sm,
    flexShrink: 0,
  },
  gapRule: {
    flex: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  nowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    marginTop: Spacing.xs,
    gap: Spacing.sm,
  },
  nowLine: {
    flex: 1,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(91,159,255,0.6)',
  },
  nowText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: Colors.stateIdle,
    fontVariant: ['tabular-nums'],
  },
});
