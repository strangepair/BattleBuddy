import { FlatList, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Colors, Spacing } from '../theme';
import HeroMetric from '../components/dashboard/HeroMetric';
import DayTimelineSection from '../components/dashboard/DayTimelineSection';
import CalendarDetailModal from '../components/dashboard/CalendarDetailModal';
import { entryLabel, entryTimestamp } from '../components/dashboard/timelineLayout';
import { useSmokingLogs } from '../hooks/useSmokingLogs';
import { useActivityLog, type ActivityLogEntry, type DayBucket } from '../hooks/useActivityLog';
import { useMemo, useState, useCallback, useEffect } from 'react';
import { useDashboardRealtime } from '../hooks/useDashboardRealtime';
import type { SmokingLog } from '../hooks/useSmokingLogs';

/**
 * MissionDashboardScreen — the "time since last cigarette" hero on top,
 * day calendar below, as ONE continuous scroll.
 *
 * A single FlatList owns all scrolling. HeroMetric is the list's
 * ListHeaderComponent — it rides the same scroll as the timeline, never a
 * fixed sibling above a second scroll region. Each item is one day rendered as an
 * hour-by-hour timeline (DayTimelineSection) where EVERY logged event —
 * cigarettes and generic activities (gym, drive, couch, meals…) — appears as
 * a labeled block at its time. Today renders first (with a NOW marker);
 * previous days lazily page in backward to account creation via
 * useActivityLog's loadMore as the user scrolls.
 *
 * There are deliberately no nested scrollables and no fixed-height panes:
 * the previous layout stacked two scroll regions (a 2,880px 24-hour canvas
 * and a history FlatList) inside a non-scrolling View whose minHeights
 * overflowed the pane, clipping the history list to a one-line window.
 *
 * Real-time layer: subscribes to `dashboard:update` SSE broadcasts and merges
 * new events into today's section without a manual refresh.
 */
export default function MissionDashboardScreen() {
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
    <>
      <FlatList
        style={styles.root}
        contentContainerStyle={styles.content}
        data={days}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={<HeroMetric logs={heroLogs} loading={loading} />}
        ListFooterComponent={ListFooter}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={true}
        initialNumToRender={4}
        maxToRenderPerBatch={8}
        windowSize={7}
      />
      <CalendarDetailModal
        visible={selectedEntry !== null}
        onDismiss={handleDismiss}
        title={modalTitle}
        description={modalDescription}
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xl,
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
