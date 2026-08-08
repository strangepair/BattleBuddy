import { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { ApiConfig } from '../config';
import { useAuthStore } from '../stores/authStore';
import { getAuthToken } from '../services/supabase';
import type { ResistanceBlock, StreakResult } from '../types/resistanceBlocks';

export interface UseResistanceBlocksResult {
  blocks: ResistanceBlock[];
  streakResult: StreakResult | null;
  isLoading: boolean;
  error: Error | null;
  startBlock: () => Promise<void>;
  closeBlock: (id: string, urgeOccurred: boolean) => Promise<void>;
  flagUrge: (id: string) => Promise<void>;
}

export function useResistanceBlocks(): UseResistanceBlocksResult {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const signOut = useAuthStore((s) => s.signOut);

  const [blocks, setBlocks] = useState<ResistanceBlock[]>([]);
  const [streakResult, setStreakResult] = useState<StreakResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchingRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBlocks = useCallback(async () => {
    if (!userId || fetchingRef.current) return;
    fetchingRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) return;

      const [blocksRes, streakRes] = await Promise.all([
        fetch(`${ApiConfig.CHAT_URL}/api/resistance-blocks`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${ApiConfig.CHAT_URL}/api/resistance-blocks/streak`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (blocksRes.status === 401 || streakRes.status === 401) {
        await signOut();
        return;
      }

      if (blocksRes.ok) {
        const json = await blocksRes.json() as ResistanceBlock[];
        setBlocks(json);
      }

      if (streakRes.ok) {
        const json = await streakRes.json() as StreakResult;
        setStreakResult(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      fetchingRef.current = false;
      setIsLoading(false);
    }
  }, [userId, signOut]);

  useEffect(() => {
    if (!userId) {
      setBlocks([]);
      setStreakResult(null);
      return;
    }
    fetchBlocks();
  }, [userId, fetchBlocks]);

  useFocusEffect(
    useCallback(() => {
      fetchBlocks();
      intervalRef.current = setInterval(fetchBlocks, 60_000);
      return () => {
        if (intervalRef.current !== null) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    }, [fetchBlocks]),
  );

  const startBlock = useCallback(async () => {
    const token = await getAuthToken();
    if (!token) return;

    const optimistic: ResistanceBlock = {
      id: `optimistic-${Date.now()}`,
      user_id: userId ?? '',
      started_at: new Date().toISOString(),
      ended_at: null,
      duration_minutes: null,
      urge_occurred: false,
      session_date: new Date().toISOString().slice(0, 10),
    };
    setBlocks((prev) => [optimistic, ...prev]);

    try {
      const res = await fetch(`${ApiConfig.CHAT_URL}/api/resistance-blocks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      if (res.status === 401) {
        await signOut();
        return;
      }

      if (res.ok) {
        const created = await res.json() as ResistanceBlock;
        setBlocks((prev) =>
          prev.map((b) => (b.id === optimistic.id ? created : b)),
        );
      } else {
        setBlocks((prev) => prev.filter((b) => b.id !== optimistic.id));
      }
    } catch (err) {
      setBlocks((prev) => prev.filter((b) => b.id !== optimistic.id));
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [userId, signOut]);

  const closeBlock = useCallback(async (id: string, urgeOccurred: boolean) => {
    const token = await getAuthToken();
    if (!token) return;

    try {
      const res = await fetch(`${ApiConfig.CHAT_URL}/api/resistance-blocks/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ urge_occurred: urgeOccurred }),
      });

      if (res.status === 401) {
        await signOut();
        return;
      }

      if (res.ok) {
        const updated = await res.json() as ResistanceBlock;
        setBlocks((prev) => prev.map((b) => (b.id === id ? updated : b)));
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [signOut]);

  const flagUrge = useCallback((id: string) => closeBlock(id, true), [closeBlock]);

  return { blocks, streakResult, isLoading, error, startBlock, closeBlock, flagUrge };
}
