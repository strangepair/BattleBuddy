import { View, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../theme';
import HeroMetric from '../components/dashboard/HeroMetric';
import DayCalendarView from '../components/dashboard/DayCalendarView';
import CalendarDetailModal from '../components/dashboard/CalendarDetailModal';
import MultiDayCalendarView from '../components/dashboard/MultiDayCalendarView';
import { useSmokingLogs } from '../hooks/useSmokingLogs';
import { useRoutineProjection } from '../hooks/useRoutineProjection';
import { useActivityLog, type ActivityLogEntry } from '../hooks/useActivityLog';
import { useMemo, useState, useCallback, useEffect } from 'react';
import type { DayLog } from '../components/dashboard/DayCalendarView';
import { useDashboardRealtime } from '../hooks/useDashboardRealtime';
import type { SmokingLog } from '../hooks/useSmokingLogs';
import type { HourSlot } from '../hooks/useRoutineProjection';

/**
 * MissionDashboardScreen is the redesigned mission dashboard.
 * It renders:
 *   1. HeroMetric — last cigarette timestamp + live elapsed-time counter.
 *   2. DayCalendarView — hourly timeline with projected routine and today's
 *      actuals, plus the last 3 days' patterns as ghost markers.
 *   3. MultiDayCalendarView — infinite backward-scrollable history list,
 *      paginated by date back to account creation. No future dates shown.
 *
 * Real-time layer: subscribes to `dashboard:update` SSE broadcasts and merges
 * new events into the actuals list without a manual refresh.
 */
export default function MissionDashboardScreen() {
  const { todayLogs, historyLogs } = useSmokingLogs();
  const projected = useRoutineProjection(historyLogs);
  const { realtimeEvents } = useDashboardRealtime(todayLogs);
  const [selectedLog, setSelectedLog] = useState<SmokingLog | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<HourSlot | null>(null);
  const handlePressLog = useCallback((log: SmokingLog) => setSelectedLog(log), []);
  const handlePressSlot = useCallback((slot: HourSlot) => setSelectedSlot(slot), []);
  const handleDismiss = useCallback(() => { setSelectedLog(null); setSelectedSlot(null); }, []);

  const mergedTodayLogs: SmokingLog[] = useMemo(() => {
    const fetchedIds = new Set(todayLogs.map((l) => l.id));
    const extra = realtimeEvents.filter((l) => !fetchedIds.has(l.id));
    return [...extra, ...todayLogs].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }, [todayLogs, realtimeEvents]);

  const previousDays: DayLog[] = useMemo(() => {
    const today = new Date();
    const todayKey = today.toDateString();

    const byDay = new Map<string, DayLog>();
    for (const log of historyLogs) {
      const d = new Date(log.occurred_at);
      const key = d.toDateString();
      if (key === todayKey) continue;
      const iso = d.toISOString().slice(0, 10);
      if (!byDay.has(iso)) byDay.set(iso, { date: iso, logs: [] });
      byDay.get(iso)!.logs.push(log);
    }

    return Array.from(byDay.values())
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
  }, [historyLogs]);

  const todayActivityEntries: ActivityLogEntry[] = useMemo(() => {
    const todayDateStr = new Date().toLocaleDateString('en-CA');
    return mergedTodayLogs
      .filter((l) => {
        const d = new Date(l.occurred_at);
        return d.toLocaleDateString('en-CA') === todayDateStr;
      })
      .map((l) => ({
        type: 'cigarette' as const,
        id: l.id,
        occurred_at: l.occurred_at,
        metadata: l.metadata,
      }));
  }, [mergedTodayLogs]);

  const { days, loadingInitial, loadingMore, hasMore, loadMore } =
    useActivityLog(todayActivityEntries);

  useEffect(() => {
    loadMore();
  }, [loadMore]);

  const modalTitle = selectedLog
    ? selectedLog.activityLabel || new Date(selectedLog.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : selectedSlot
    ? `Projected routine`
    : '';
  const modalDescription = selectedLog
    ? [
        selectedLog.location ? `Location: ${selectedLog.location}` : null,
        selectedLog.occurred_at
          ? `Time: ${new Date(selectedLog.occurred_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
          : null,
      ]
        .filter(Boolean)
        .join('\n') || 'No additional details.'
    : selectedSlot
    ? `Average of ~${selectedSlot.avgCount.toFixed(1)} cigarette(s) at ${selectedSlot.hour === 0 ? '12:00 AM' : selectedSlot.hour < 12 ? `${selectedSlot.hour}:00 AM` : selectedSlot.hour === 12 ? '12:00 PM' : `${selectedSlot.hour - 12}:00 PM`} based on your past 14 days.`
    : '';

  return (
    <>
      <View style={styles.root}>
        <HeroMetric realtimeLogs={mergedTodayLogs} />
        <View style={styles.dayView}>
          <DayCalendarView
            projected={projected}
            actuals={mergedTodayLogs}
            previousDays={previousDays}
            onPressLog={handlePressLog}
            onPressSlot={handlePressSlot}
          />
        </View>
        <View style={styles.historyView}>
          <MultiDayCalendarView
            days={days}
            loadingInitial={loadingInitial}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onEndReached={loadMore}
          />
        </View>
      </View>
      <CalendarDetailModal
        visible={selectedLog !== null || selectedSlot !== null}
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
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    gap: Spacing.md,
  },
  dayView: {
    flex: 2,
    minHeight: 260,
  },
  historyView: {
    flex: 1,
    minHeight: 160,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
  },
});
