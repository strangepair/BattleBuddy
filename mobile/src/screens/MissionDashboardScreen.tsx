import { FlatList, View, Text, StyleSheet, ActivityIndicator, type LayoutChangeEvent } from 'react-native';
import { Colors, Spacing } from '../theme';
import HeroMetric from '../components/dashboard/HeroMetric';
import DayTimelineSection from '../components/dashboard/DayTimelineSection';
import CalendarDetailModal from '../components/dashboard/CalendarDetailModal';
import { entryLabel, entryTimestamp, dayGridHeight, HOUR_HEIGHT } from '../components/dashboard/timelineLayout';
import { useSmokingLogs } from '../hooks/useSmokingLogs';
import { useActivityLog, type ActivityLogEntry, type DayBucket } from '../hooks/useActivityLog';
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useDashboardRealtime } from '../hooks/useDashboardRealtime';
import type { SmokingLog } from '../hooks/useSmokingLogs';

/**
 * MissionDashboardScreen — the "time since last cigarette" hero on top,
 * bottom-anchored day calendar below.
 *
 * A single INVERTED FlatList owns all scrolling. The days array is
 * newest-first, so with `inverted` today sits at the BOTTOM: the view opens
 * anchored at the NOW line, and pulling down scrolls back through earlier
 * hours and previous days, lazily appending older days at the visual TOP
 * (append-at-array-end in an inverted list shifts nothing — no jump on
 * load). Each day is a fixed-hour time grid (DayTimelineSection): every
 * hour a uniform height, every logged event — cigarettes and generic
 * activities — a block at its minute offset sized by its duration
 * (5-minute visual floor for instant logs).
 *
 * The hero is a plain fixed card ABOVE the list: in a bottom-anchored
 * timeline a scroll-away header would sit beyond all of history and never
 * be visible on open. This is still exactly ONE scroll surface — the #150
 * antipattern was two scrollables clipped inside fixed-height panes, and
 * none of that returns here.
 *
 * Real-time layer: subscribes to `dashboard:update` SSE broadcasts and merges
 * new events into today's section without a manual refresh.
 */
export default function MissionDashboardScreen() {
  const flatListRef = useRef<FlatList>(null);
  const listHeightRef = useRef<number>(0);
  const scrolledRef = useRef(false);
  const { todayLogs, historyLogs, loading } = useSmokingLogs();
  const { realtimeEvents } = useDashboardRealtime(todayLogs);
  const [selectedEntry, setSelectedEntry] = useState<ActivityLogEntry | null>(null);
  const handlePressEntry = useCallback((entry: ActivityLogEntry) => setSelectedEntry(entry), []);
  const handleDismiss = useCallback(() => { setSelectedEntry(null); }, []);

  const mergedTodayLogs: SmokingLog[] = useMemo(() => {
    const fetchedIds = new Set(todayLogs.map((l) => l.id));
    const extra = realtimeEvents.filter((l) => !fetchedIds.has(l.id));
    return [...extra, ...todayLogs].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }, [todayLogs, realtimeEvents]);

  const heroLogs = useMemo(
    () => [...mergedTodayLogs, ...historyLogs],
    [mergedTodayLogs, historyLogs],
  );

  const todayCigaretteEntries: ActivityLogEntry[] = useMemo(
    () =>
      mergedTodayLogs.map((l) => ({
        type: 'cigarette' as const,
        id: l.id,
        occurred_at: l.occurred_at,
        activityLabel: l.activityLabel,
        location: l.location ?? null,
        metadata: l.metadata,
      })),
    [mergedTodayLogs],
  );

  const { days, loadingInitial, loadingMore, hasMore, loadMore } =
    useActivityLog(todayCigaretteEntries);

  useEffect(() => {
    loadMore();
  }, [loadMore]);

  const scrollToCurrentHour = useCallback(() => {
    if (scrolledRef.current || listHeightRef.current === 0 || days.length === 0) return;
    const now = new Date();
    const gridHeight = dayGridHeight(true, now);
    const currentHourTop = now.getHours() * HOUR_HEIGHT;
    const offset = gridHeight - currentHourTop - listHeightRef.current;
    if (offset > 0) {
      flatListRef.current?.scrollToOffset({ offset, animated: false });
    }
    scrolledRef.current = true;
  }, [days.length]);

  const handleListLayout = useCallback((e: LayoutChangeEvent) => {
    listHeightRef.current = e.nativeEvent.layout.height;
    scrollToCurrentHour();
  }, [scrollToCurrentHour]);

  useEffect(() => {
    if (days.length > 0) scrollToCurrentHour();
  }, [days.length, scrollToCurrentHour]);

  const todayKey = days[0]?.date;
  const renderItem = useCallback(
    ({ item }: { item: DayBucket }) => (
      <DayTimelineSection
        bucket={item}
        isToday={item.date === todayKey}
        onPressEntry={handlePressEntry}
      />
    ),
    [todayKey, handlePressEntry],
  );
  const keyExtractor = useCallback((item: DayBucket) => item.date, []);

  // In an inverted list the footer renders at the visual TOP — exactly where
  // "loading older days" / "beginning of history" belongs.
  const ListFooter = useCallback(() => {
    if (loadingInitial || loadingMore) {
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
  }, [loadingInitial, loadingMore, hasMore, days.length]);

  const modalTitle = selectedEntry ? entryLabel(selectedEntry) : '';
  const modalDescription = selectedEntry
    ? [
        selectedEntry.location ? `Location: ${selectedEntry.location}` : null,
        (() => {
          const ts = entryTimestamp(selectedEntry);
          return ts
            ? `Time: ${new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
            : null;
        })(),
      ]
        .filter(Boolean)
        .join('\n') || 'No additional details.'
    : '';

  return (
    <View style={styles.root}>
      <HeroMetric logs={heroLogs} loading={loading} />
      <FlatList
        ref={flatListRef}
        style={styles.list}
        contentContainerStyle={styles.content}
        data={days}
        inverted
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListFooterComponent={ListFooter}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={true}
        initialNumToRender={2}
        maxToRenderPerBatch={4}
        windowSize={5}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onLayout={handleListLayout}
      />
      <CalendarDetailModal
        visible={selectedEntry !== null}
        onDismiss={handleDismiss}
        title={modalTitle}
        description={modalDescription}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xs,
  },
  list: {
    flex: 1,
  },
  content: {
    // Inverted list: "top" padding here is the visual bottom, next to NOW.
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
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
