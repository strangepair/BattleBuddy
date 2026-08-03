import { useState, useCallback, useRef, useEffect } from 'react';
import { fetchSessions, type Session } from '../api/sessions';

export interface UseSessionHistoryResult {
  sessions: Session[];
  nextCursor: string | null;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

export function useSessionHistory(): UseSessionHistoryResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const fetchingRef = useRef(false);
  const lastCursorRef = useRef<string>(new Date().toISOString());

  const doFetch = useCallback(async (before: string, append: boolean) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSessions(before);
      setSessions((prev) =>
        append ? [...prev, ...result.sessions] : result.sessions,
      );
      setNextCursor(result.nextCursor);
      setHasMore(result.nextCursor !== null);
      if (result.nextCursor) {
        lastCursorRef.current = result.nextCursor;
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    doFetch(new Date().toISOString(), false);
  }, [doFetch]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading || !nextCursor) return;
    doFetch(nextCursor, true);
  }, [hasMore, loading, nextCursor, doFetch]);

  const retry = useCallback(() => {
    doFetch(lastCursorRef.current, sessions.length > 0);
  }, [doFetch, sessions.length]);

  return { sessions, nextCursor, loading, error, hasMore, loadMore, retry };
}
