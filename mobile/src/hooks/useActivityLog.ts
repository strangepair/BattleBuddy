import { useState, useCallback, useRef } from 'react';
import { ApiConfig } from '../config';
import { useAuthStore } from '../stores/authStore';
import { getAuthToken } from '../services/supabase';

export interface ActivityLogEntry {
  type: 'cigarette' | 'activity';
  id: string;
  occurred_at?: string;
  start_time?: string;
  end_time?: string | null;
  activity_name?: string;
  activityLabel?: string;
  location?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DayBucket {
  date: string;
  entries: ActivityLogEntry[];
}

const PAGE_SIZE = 50;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Local calendar date (YYYY-MM-DD) of a timestamp. Uses the device timezone
 * so an evening entry lands on the day the user experienced it — a plain
 * `.slice(0, 10)` on a UTC instant puts anything after ~5 PM US time on
 * "tomorrow", which is how entries used to jump days.
 */
function isoDate(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function entryTimestamp(e: ActivityLogEntry): string {
  return (e.occurred_at ?? e.start_time) as string;
}

function bucketByDay(entries: ActivityLogEntry[]): DayBucket[] {
  const map = new Map<string, ActivityLogEntry[]>();
  for (const entry of entries) {
    const ts = entryTimestamp(entry);
    if (!ts) continue;
    const day = isoDate(ts);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(entry);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, es]) => ({ date, entries: es }));
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fillEmptyDays(buckets: DayBucket[], from: string, to: string): DayBucket[] {
  const filled: DayBucket[] = [];
  const existing = new Map(buckets.map((b) => [b.date, b]));
  const cursor = new Date(`${to}T00:00:00Z`);
  const stop = new Date(`${from}T00:00:00Z`);
  while (cursor >= stop) {
    const d = cursor.toISOString().slice(0, 10);
    filled.push(existing.get(d) ?? { date: d, entries: [] });
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return filled;
}

interface UseActivityLogResult {
  days: DayBucket[];
  loadingInitial: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

/**
 * Assembles the day-bucketed mission timeline.
 *
 * Today's cigarettes arrive via `todayEntries` (the realtime-merged feed from
 * useSmokingLogs — authoritative for today's cigarette count). Today's generic
 * *activity* entries, and all past days, come from GET /logs, paginated
 * backward on demand (`loadMore`) down to the account creation date.
 */
export function useActivityLog(
  todayEntries: ActivityLogEntry[],
): UseActivityLogResult {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const accountCreatedAt = useAuthStore((s) =>
    s.user?.createdAt ? new Date(s.user.createdAt).toISOString().slice(0, 10) : null,
  );

  const [historyBuckets, setHistoryBuckets] = useState<DayBucket[]>([]);
  const [todayActivities, setTodayActivities] = useState<ActivityLogEntry[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<string | null>(null);
  const fetchingRef = useRef(false);
  const initializedRef = useRef(false);
  const dayCache = useRef<Map<string, DayBucket>>(new Map());

  const fetchPage = useCallback(
    async (before: string | null) => {
      if (!userId || fetchingRef.current) return;
      fetchingRef.current = true;
      const isFirst = before === null;
      if (isFirst) setLoadingInitial(true);
      else setLoadingMore(true);

      try {
        const token = await getAuthToken();
        if (!token) return;
        const params = new URLSearchParams({
          userId,
          limit: String(PAGE_SIZE),
        });
        if (before) params.set('before', before);
        const res = await fetch(
          `${ApiConfig.CHAT_URL}/logs?${params.toString()}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return;
        const json = await res.json() as { logs: ActivityLogEntry[]; count: number };
        const entries: ActivityLogEntry[] = json.logs ?? [];

        const today = todayISO();
        const pastEntries = entries.filter((e) => {
          const ts = entryTimestamp(e);
          return ts && isoDate(ts) < today;
        });

        // Today's activity entries only live in /logs (the realtime feed
        // carries cigarettes alone) — keep them for the today bucket instead
        // of dropping the whole day. Today's /logs cigarettes ARE dropped:
        // the realtime-merged feed owns those, avoiding double-counts.
        const todaysActivities = entries.filter((e) => {
          const ts = entryTimestamp(e);
          return e.type === 'activity' && ts && isoDate(ts) === today;
        });
        if (todaysActivities.length > 0) {
          setTodayActivities((prev) => {
            const ids = new Set(prev.map((e) => e.id));
            const fresh = todaysActivities.filter((e) => !ids.has(e.id));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
        }

        const newBuckets = bucketByDay(pastEntries);

        setHistoryBuckets((prev) => {
          const merged = new Map(prev.map((b) => [b.date, b]));
          for (const b of newBuckets) {
            if (merged.has(b.date)) {
              const existing = merged.get(b.date)!;
              const ids = new Set(existing.entries.map((e) => e.id));
              const merged_bucket: DayBucket = {
                date: b.date,
                entries: [...existing.entries, ...b.entries.filter((e) => !ids.has(e.id))],
              };
              merged.set(b.date, merged_bucket);
              dayCache.current.set(b.date, merged_bucket);
            } else {
              merged.set(b.date, b);
              dayCache.current.set(b.date, b);
            }
          }
          return Array.from(merged.values()).sort((a, b) => b.date.localeCompare(a.date));
        });

        if (entries.length < PAGE_SIZE) {
          setHasMore(false);
        } else {
          const oldest = entries.reduce<string | null>((min, e) => {
            const ts = entryTimestamp(e);
            if (!ts) return min;
            return min === null || ts < min ? ts : min;
          }, null);
          cursorRef.current = oldest;
        }
      } catch {
        // silently degrade
      } finally {
        fetchingRef.current = false;
        if (isFirst) setLoadingInitial(false);
        else setLoadingMore(false);
      }
    },
    [userId],
  );

  const loadMore = useCallback(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      fetchPage(null);
    } else if (hasMore && !fetchingRef.current) {
      const cursor = cursorRef.current;
      if (cursor) {
        const nextDay = isoDate(cursor);
        if (dayCache.current.has(nextDay)) {
          return;
        }
      }
      fetchPage(cursor);
    }
  }, [fetchPage, hasMore]);

  const today = todayISO();
  const accountStart = accountCreatedAt ?? today;

  const todayOnlyEntries = todayEntries.filter((e) => {
    const ts = entryTimestamp(e);
    return ts ? isoDate(ts) === today : false;
  });

  const seenToday = new Set(todayOnlyEntries.map((e) => e.id));
  const todayBucket: DayBucket = {
    date: today,
    entries: [
      ...todayOnlyEntries,
      ...todayActivities.filter((e) => !seenToday.has(e.id) && isoDate(entryTimestamp(e)) === today),
    ],
  };

  const allDays = (() => {
    if (historyBuckets.length === 0) return [todayBucket];
    const newestHistory = historyBuckets[0]?.date ?? today;
    const oldestLoaded = historyBuckets[historyBuckets.length - 1]?.date ?? today;
    const fillFrom = hasMore ? oldestLoaded : accountStart;
    const historyFilled = fillEmptyDays(historyBuckets, fillFrom, newestHistory);
    return [todayBucket, ...historyFilled];
  })();

  return {
    days: allDays,
    loadingInitial,
    loadingMore,
    hasMore,
    loadMore,
  };
}
