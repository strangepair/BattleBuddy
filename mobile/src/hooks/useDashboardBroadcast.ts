import { useEffect, useRef, useState } from 'react';
import { subscribe, unsubscribe, startRealtime, stopRealtime } from '../services/realtimeClient';
import { useAuthStore } from '../stores/authStore';
import type { SmokingLog } from './useSmokingLogs';

export interface DashboardUpdatePayload {
  event: { id: string; type: string; timestamp: string };
  today_count: number;
  current_gap_minutes: number;
  longest_gap_today_minutes: number;
}

function isDashboardUpdatePayload(v: unknown): v is DashboardUpdatePayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.today_count === 'number' &&
    typeof p.current_gap_minutes === 'number' &&
    typeof p.longest_gap_today_minutes === 'number' &&
    typeof p.event === 'object' &&
    p.event !== null
  );
}

export function newLogFromPayload(payload: DashboardUpdatePayload): SmokingLog {
  const ev = payload.event as { id: string; type: string; timestamp: string };
  return {
    id: ev.id,
    user_id: '',
    occurred_at: ev.timestamp,
  };
}

export function useDashboardBroadcast(): DashboardUpdatePayload | null {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [latest, setLatest] = useState<DashboardUpdatePayload | null>(null);
  const handlerRef = useRef<(payload: unknown) => void>(() => {});

  useEffect(() => {
    handlerRef.current = (payload: unknown) => {
      if (isDashboardUpdatePayload(payload)) {
        setLatest(payload);
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

  return latest;
}
