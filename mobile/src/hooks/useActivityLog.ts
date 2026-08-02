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
  location?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DayBucket {
  date: string;
  entries: ActivityLogEntry[];
}

const PAGE_SIZE = 50;

function isoDate(ts: string): string {
  return ts.slice(0, 10);
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
  return new Date().toISOString().slice(0, 10);
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

export function useActivityLog(
  todayEntries: ActivityLogEntry[],
): UseActivityLogResult {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const accountCreatedAt = useAuthStore((s) =>
    s.user?.createdAt ? new Date(s.user.createdAt).toISOString().slice(0, 10) : null,
  );

  const [historyBuckets, setHistoryBuckets] = useState<DayBucket[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<string | null>(null);
  const fetchingRef = useRef(false);
  const initializedRef = useRef(false);

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

        const newBuckets = bucketByDay(pastEntries);

        setHistoryBuckets((prev) => {
          const merged = new Map(prev.map((b) => [b.date, b]));
          for (const b of newBuckets) {
            if (merged.has(b.date)) {
              const existing = merged.get(b.date)!;
              const ids = new Set(existing.entries.map((e) => e.id));
              merged.set(b.date, {
                date: b.date,
                entries: [...existing.entries, ...b.entries.filter((e) => !ids.has(e.id))],
              });
            } else {
              merged.set(b.date, b);
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
      fetchPage(cursorRef.current);
    }
  }, [fetchPage, hasMore]);

  const today = todayISO();
  const accountStart = accountCreatedAt ?? today;

  const todayBucket: DayBucket = { date: today, entries: todayEntries };

  const allDays = (() => {
    if (historyBuckets.length === 0) return [todayBucket];
    const oldestLoaded = historyBuckets[historyBuckets.length - 1]?.date ?? today;
    const fillFrom = hasMore ? oldestLoaded : accountStart;
    const historyFilled = fillEmptyDays(historyBuckets, fillFrom, oldestLoaded);
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
