import { ScrollView, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../theme';
import HeroMetric from '../components/dashboard/HeroMetric';
import DayCalendarView from '../components/dashboard/DayCalendarView';
import { useSmokingLogs } from '../hooks/useSmokingLogs';
import { useRoutineProjection } from '../hooks/useRoutineProjection';
import { useMemo } from 'react';
import type { DayLog } from '../components/dashboard/DayCalendarView';
import { useDashboardRealtime } from '../hooks/useDashboardRealtime';
import type { SmokingLog } from '../hooks/useSmokingLogs';

/**
 * MissionDashboardScreen is the redesigned mission dashboard.
 * It renders:
 *   1. HeroMetric — last cigarette timestamp + live elapsed-time counter.
 *   2. DayCalendarView — hourly timeline with projected routine and today's
 *      actuals, plus the last 3 days' patterns as ghost markers.
 *
 * Real-time layer: subscribes to `dashboard:update` SSE broadcasts and merges
 * new events into the actuals list without a manual refresh.
 */
export default function MissionDashboardScreen() {
  const { todayLogs, historyLogs } = useSmokingLogs();
  const projected = useRoutineProjection(historyLogs);
  const { realtimeEvents } = useDashboardRealtime(todayLogs);

  const mergedTodayLogs: SmokingLog[] = useMemo(() => {
    const fetchedIds = new Set(todayLogs.map((l) => l.id));
    const extra = realtimeEvents.filter((l) => !fetchedIds.has(l.id));
    return [...extra, ...todayLogs].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
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

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <HeroMetric realtimeLogs={mergedTodayLogs} />
      <DayCalendarView projected={projected} actuals={mergedTodayLogs} previousDays={previousDays} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  container: {
    padding: Spacing.md,
    gap: Spacing.md,
    paddingBottom: Spacing.xl,
  },
});
