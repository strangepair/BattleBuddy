import { ApiConfig } from '../config';

export async function logEvent(
  userId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  occurredAt?: string,
): Promise<void> {
  try {
    await fetch(`${ApiConfig.CHAT_URL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'America/Chicago';
  }
}

/** One local day of events (YYYY-MM-DD in the device timezone), metadata
    included — feeds the hour-by-hour day calendar. The server resolves the
    date to a [start, end] range in the given timezone (dayRangeInTz). */
export async function fetchDayEvents(userId: string | null, date: string): Promise<BBEvent[]> {
  if (!userId) return [];
  try {
    const res = await fetch(
      `${ApiConfig.CHAT_URL}/events?userId=${encodeURIComponent(userId)}&date=${encodeURIComponent(date)}&limit=100&timezone=${encodeURIComponent(deviceTz())}`,
    );
    if (!res.ok) return [];
    const json = await res.json();
    return json.events ?? [];
  } catch {
    return [];
  }
}

/** Recent raw events — feeds the "Where you stand" tiles (today's count,
    urges ridden out this week), mirroring the web head's refreshStats. */
export async function fetchRecentEvents(
  userId: string | null,
  limit = 300,
): Promise<BBEvent[]> {
  if (!userId) return [];
  try {
    const tz = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Chicago'; }
    })();
    const res = await fetch(
      `${ApiConfig.CHAT_URL}/events?userId=${encodeURIComponent(userId)}&limit=${limit}&timezone=${encodeURIComponent(tz)}`,
    );
    if (!res.ok) return [];
    const json = await res.json();
    return json.events ?? [];
  } catch {
    return [];
  }
}
