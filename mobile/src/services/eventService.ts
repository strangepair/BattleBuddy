import { ApiConfig } from '../config';
import { getAuthToken } from './supabase';

export async function logEvent(
  userId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  occurredAt?: string,
): Promise<void> {
  try {
    const token = await getAuthToken();
    if (!token) return;
    await fetch(`${ApiConfig.CHAT_URL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId, eventType, occurredAt: occurredAt || new Date().toISOString(), metadata }),
    });
  } catch (err) {
    console.warn('[eventService] Failed to log event:', err);
    // Non-blocking — don't throw
  }
}

export interface BBEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

/** Recent raw events — feeds the "Where you stand" tiles (today's count,
    urges ridden out this week), mirroring the web head's refreshStats. */
export async function fetchRecentEvents(
  userId: string | null,
  limit = 300,
): Promise<BBEvent[]> {
  if (!userId) return [];
  try {
    const token = await getAuthToken();
    if (!token) return [];
    const tz = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Chicago'; }
    })();
    const res = await fetch(
      `${ApiConfig.CHAT_URL}/events?userId=${encodeURIComponent(userId)}&limit=${limit}&timezone=${encodeURIComponent(tz)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const json = await res.json();
    return json.events ?? [];
  } catch {
    return [];
  }
}
