import { useEffect, useState } from 'react';
import { ApiConfig } from '../config';
import { useAuthStore } from '../stores/authStore';

export interface SmokingLog {
  id: string;
  user_id: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
  activityLabel?: string;
  location?: string;
}

interface UseSmokingLogsResult {
  todayLogs: SmokingLog[];
  historyLogs: SmokingLog[];
  loading: boolean;
}

/**
 * Fetches the current user's cigarette logs from the server via
 * GET /dashboard/today — which queries bb_events through resolveUserId so
 * aliasing is consistent with POST /events and the broadcast path.
 *
 * `todayLogs`   — entries whose `occurred_at` falls within today (user TZ).
 * `historyLogs` — entries from prior days (used for projection / ghost markers).
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

    async function load() {
      setLoading(true);
      try {
        const tz = (() => {
          try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Chicago'; }
        })();
        const res = await fetch(
          `${ApiConfig.CHAT_URL}/dashboard/today?userId=${encodeURIComponent(userId!)}&timezone=${encodeURIComponent(tz)}`,
        );
        if (!res.ok || cancelled) return;
        const json = await res.json();

        const toLog = (e: { id: string; instant: string; activityLabel?: string | null; location?: string | null }): SmokingLog => ({
          id: e.id,
          user_id: userId!,
          occurred_at: e.instant,
          activityLabel: e.activityLabel ?? undefined,
          location: e.location ?? undefined,
        });

        const today: SmokingLog[] = (json.todayEntries ?? []).map(toLog);
        const history: SmokingLog[] = (json.recentHistory ?? []).map(toLog);

        if (!cancelled) {
          setTodayLogs(today);
          setHistoryLogs(history);
        }
      } catch {
        if (!cancelled) {
          setTodayLogs([]);
          setHistoryLogs([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [userId]);

  return { todayLogs, historyLogs, loading };
}
