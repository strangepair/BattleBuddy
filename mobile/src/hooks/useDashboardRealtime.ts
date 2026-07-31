import { useEffect, useRef, useState } from 'react';
import { subscribe, unsubscribe, startRealtime, stopRealtime } from '../services/realtimeClient';
import { useAuthStore } from '../stores/authStore';
import type { SmokingLog } from './useSmokingLogs';

export interface DashboardRealtimeState {
  todayCount: number | null;
  currentGapMinutes: number | null;
  longestGapTodayMinutes: number | null;
  realtimeEvents: SmokingLog[];
}

interface BroadcastEntry {
  id: string;
  instant: string;
  activityLabel?: string | null;
  location?: string | null;
}

interface BroadcastPayload {
  event: BroadcastEntry | null;
  todayCount: number;
  currentGapMinutes: number | null;
  longestGapTodayMinutes: number;
}

function isBroadcastPayload(v: unknown): v is BroadcastPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.todayCount === 'number' &&
    typeof p.longestGapTodayMinutes === 'number' &&
    'currentGapMinutes' in p &&
    'event' in p
  );
}

export function useDashboardRealtime(
  initialTodayLogs: SmokingLog[] = [],
): DashboardRealtimeState {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [currentGapMinutes, setCurrentGapMinutes] = useState<number | null>(null);
  const [longestGapTodayMinutes, setLongestGapTodayMinutes] = useState<number | null>(null);
  const [realtimeEvents, setRealtimeEvents] = useState<SmokingLog[]>([]);

  const seenIds = useRef(new Set<string>());
  const handlerRef = useRef<(payload: unknown) => void>(() => {});

  useEffect(() => {
    seenIds.current = new Set(initialTodayLogs.map((l) => l.id));
  }, [initialTodayLogs]);

  useEffect(() => {
    handlerRef.current = (payload: unknown) => {
      if (!isBroadcastPayload(payload)) return;

      setTodayCount(payload.todayCount);
      setCurrentGapMinutes(payload.currentGapMinutes);
      setLongestGapTodayMinutes(payload.longestGapTodayMinutes);

      const ev = payload.event;
      if (ev && !seenIds.current.has(ev.id)) {
        seenIds.current.add(ev.id);
        const newLog: SmokingLog = {
          id: ev.id,
          user_id: userId ?? '',
          occurred_at: ev.instant,
          activityLabel: ev.activityLabel ?? undefined,
          location: ev.location ?? undefined,
        };
        setRealtimeEvents((prev) => {
          const merged = [...prev, newLog].sort((a, b) =>
            a.occurred_at.localeCompare(b.occurred_at),
          );
          return merged;
        });
      }
    };
  });

  useEffect(() => {
    if (!userId) return;
    startRealtime(userId);
    const handler = (payload: unknown) => handlerRef.current(payload);
    subscribe('dashboard:update', handler);
    return () => {
      unsubscribe('dashboard:update', handler);
      stopRealtime();
    };
  }, [userId]);

  return { todayCount, currentGapMinutes, longestGapTodayMinutes, realtimeEvents };
}
