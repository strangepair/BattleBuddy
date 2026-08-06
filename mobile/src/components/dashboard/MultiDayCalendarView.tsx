import { useCallback, useRef, useEffect } from 'react';
import { FlatList, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';
import type { DayBucket, ActivityLogEntry } from '../../hooks/useActivityLog';

interface MultiDayCalendarViewProps {
  days: DayBucket[];
  loadingInitial: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onEndReached: () => void;
}

const DAY_HEADER_HEIGHT = 36;
const ENTRY_ROW_HEIGHT = 40;
const EMPTY_ROW_HEIGHT = 32;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDayHeader(dateStr: string): string {
  const today = todayISO();
  if (dateStr === today) return 'TODAY';
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function entryTimestamp(e: ActivityLogEntry): string {
  return (e.occurred_at ?? e.start_time) as string;
}

interface DayRowProps {
  bucket: DayBucket;
  isToday: boolean;
}

function entryDateISO(e: ActivityLogEntry): string {
  const ts = entryTimestamp(e);
  return ts ? ts.slice(0, 10) : '';
}

function DayRow({ bucket, isToday }: DayRowProps) {
  const sorted = [...bucket.entries]
    .filter((e) => entryDateISO(e) === bucket.date)
    .sort((a, b) => {
      const ta = entryTimestamp(a);
      const tb = entryTimestamp(b);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

  return (
    <View style={styles.dayRow}>
      <View style={[styles.dayHeader, isToday && styles.dayHeaderToday]}>
        <Text style={[styles.dayHeaderText, isToday && styles.dayHeaderTextToday]}>
          {fmtDayHeader(bucket.date)}
        </Text>
        {sorted.length > 0 && (
          <Text style={styles.dayCount}>{sorted.length}</Text>
        )}
      </View>
      {sorted.length === 0 ? (
        <View style={styles.emptyRow}>
          <Text style={styles.emptyText}>—</Text>
        </View>
      ) : (
        sorted.map((entry) => {
          const ts = entryTimestamp(entry);
          const label =
            entry.type === 'cigarette'
              ? entry.metadata?.activityLabel as string | undefined ?? 'Cigarette'
              : (entry.activity_name ?? 'Activity');
          return (
            <View key={entry.id} style={styles.entryRow}>
              <View style={[styles.entryDot, entry.type === 'activity' && styles.entryDotActivity]} />
              <Text style={styles.entryTime}>{ts ? fmtTime(ts) : ''}</Text>
              <Text style={styles.entryLabel} numberOfLines={1} ellipsizeMode="tail">
                {label}
              </Text>
            </View>
          );
        })
      )}
    </View>
  );
}

export default function MultiDayCalendarView({
  days,
  loadingInitial,
  loadingMore,
  hasMore,
  onEndReached,
}: MultiDayCalendarViewProps) {
  const flatListRef = useRef<FlatList<DayBucket>>(null);
  const today = todayISO();

  useEffect(() => {
    if (days.length > 0 && days[0].date === today) {
      flatListRef.current?.scrollToIndex({ index: 0, animated: false });
    }
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: DayBucket }) => (
      <DayRow bucket={item} isToday={item.date === today} />
    ),
    [today],
  );

  const keyExtractor = useCallback((item: DayBucket) => item.date, []);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => {
      const bucket = days[index];
      const entryCount = bucket?.entries.length ?? 0;
      const height =
        DAY_HEADER_HEIGHT +
        (entryCount === 0 ? EMPTY_ROW_HEIGHT : entryCount * ENTRY_ROW_HEIGHT);
      let offset = 0;
      for (let i = 0; i < index; i++) {
        const c = days[i]?.entries.length ?? 0;
        offset += DAY_HEADER_HEIGHT + (c === 0 ? EMPTY_ROW_HEIGHT : c * ENTRY_ROW_HEIGHT);
      }
      return { length: height, offset, index };
    },
    [days],
  );

  const ListFooter = useCallback(() => {
    if (loadingMore) {
      return (
        <View style={styles.footer}>
          <ActivityIndicator size="small" color={Colors.textTertiary} />
        </View>
      );
    }
    if (!hasMore && days.length > 1) {
      return (
        <View style={styles.footer}>
          <Text style={styles.footerText}>Beginning of history</Text>
        </View>
      );
    }
    return null;
  }, [loadingMore, hasMore, days.length]);

  if (loadingInitial) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={Colors.textTertiary} />
      </View>
    );
  }

  return (
    <FlatList
      ref={flatListRef}
      data={days}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      getItemLayout={getItemLayout}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.4}
      ListFooterComponent={ListFooter}
      style={styles.list}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={true}
      initialNumToRender={7}
      maxToRenderPerBatch={14}
      windowSize={10}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  content: {
    paddingBottom: Spacing.xl,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
  },
  dayRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
    paddingBottom: Spacing.xs,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
    height: DAY_HEADER_HEIGHT,
  },
  dayHeaderToday: {
    backgroundColor: `${Colors.stateIdle}14`,
  },
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
    height: EMPTY_ROW_HEIGHT,
    paddingHorizontal: Spacing.md,
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: Colors.textTertiary,
    marginLeft: Spacing.md,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    height: ENTRY_ROW_HEIGHT,
    gap: Spacing.sm,
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
    fontWeight: '600',
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
    width: 56,
    flexShrink: 0,
  },
  entryLabel: {
    fontSize: 13,
    color: Colors.textPrimary,
    flex: 1,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  footerText: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
});
