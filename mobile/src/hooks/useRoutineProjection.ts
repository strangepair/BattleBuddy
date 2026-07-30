import { useMemo } from 'react';
import type { SmokingLog } from './useSmokingLogs';

export interface HourSlot {
  hour: number;
  avgCount: number;
}

/**
 * Aggregates the user's historical smoking logs (past 14 days) into a
 * per-hour average count — the "projected routine" layer on the calendar.
 *
 * @param historyLogs - All log entries from the past 14 days.
 * @returns An array of 24 HourSlot objects (one per hour, 0–23).
 */
export function useRoutineProjection(historyLogs: SmokingLog[]): HourSlot[] {
  return useMemo(() => {
    const DAY_WINDOW = 14;
    const hourBuckets = new Array<number>(24).fill(0);

    for (const log of historyLogs) {
      const d = new Date(log.occurred_at);
      hourBuckets[d.getHours()] += 1;
    }

    return hourBuckets.map((total, hour) => ({
      hour,
      avgCount: total / DAY_WINDOW,
    }));
  }, [historyLogs]);
}
