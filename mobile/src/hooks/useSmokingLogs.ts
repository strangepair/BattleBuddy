import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import { useAuthStore } from '../stores/authStore';

export interface SmokingLog {
  id: string;
  user_id: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

interface UseSmokingLogsResult {
  todayLogs: SmokingLog[];
  historyLogs: SmokingLog[];
  loading: boolean;
}

/**
 * Fetches the current user's cigarette logs from Supabase.
 * `todayLogs` — entries where `occurred_at` is today (local midnight → now).
 * `historyLogs` — entries from the past 14 days (used for projection).
 */
export function useSmokingLogs(): UseSmokingLogsResult {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [todayLogs, setTodayLogs] = useState<SmokingLog[]>([]);
  const [historyLogs, setHistoryLogs] = useState<SmokingLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setTodayLogs([]);
      setHistoryLogs([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetch() {
      setLoading(true);
      try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

        const { data: history } = await supabase
          .from('smoking_logs')
          .select('id, user_id, occurred_at, metadata')
          .eq('user_id', userId)
          .gte('occurred_at', fourteenDaysAgo)
          .order('occurred_at', { ascending: false });

        if (cancelled) return;

        const logs: SmokingLog[] = history ?? [];
        const today = logs.filter((l) => l.occurred_at >= todayStart);
        setHistoryLogs(logs);
        setTodayLogs(today);
      } catch {
        if (!cancelled) {
          setTodayLogs([]);
          setHistoryLogs([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetch();
    return () => { cancelled = true; };
  }, [userId]);

  return { todayLogs, historyLogs, loading };
}
