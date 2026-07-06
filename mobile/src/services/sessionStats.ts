import { ApiConfig } from '../config';

// Single source of truth for "how many sessions/reports does this user have,
// and what's their streak/resist-rate" — History, Analytics, and Goals all
// rendered contradictory numbers (8 / 1 / 0) for the same user because each
// screen queried a different event slice and computed its own math. Every
// screen that shows a count or streak should go through this module.

export interface SessionEventRow {
  id: string;
  occurredAt: string;
  mode: string;
  outcome: string | null;
  helped: boolean | null;
  intensityStart: number | null;
  intensityEnd: number | null;
}

export interface SessionReportRow {
  createdAt: string;
  summary: string;
  triggerType: string | null;
  triggerIntensity: number | null;
  outcome: string | null;
  emotionalArc: { start?: string; end?: string };
  whatHelped: string[];
  whatDidntHelp: string[];
  nextSessionHint: string | null;
  preferences: Record<string, any>;
}

export interface SessionStats {
  sessions: SessionEventRow[];
  reports: SessionReportRow[];
  totalSessions: number;
  /** Consecutive resisted outcomes counting back from the most recent session. */
  streak: number;
  /** 0-100, rounded. 0 when there are no recorded outcomes yet. */
  resistRate: number;
  preferredMode: 'text' | 'voice' | null;
}

function mapSessionEvent(e: any): SessionEventRow {
  return {
    id: e.id,
    occurredAt: e.occurred_at,
    mode: e.metadata?.mode ?? 'text',
    outcome: e.metadata?.outcome ?? null,
    helped: e.metadata?.helped ?? null,
    intensityStart: e.metadata?.intensity_start ?? null,
    intensityEnd: e.metadata?.intensity_end ?? null,
  };
}

function mapReportEvent(e: any): SessionReportRow {
  const r = e.metadata?.report || {};
  return {
    createdAt: e.occurred_at,
    summary: r.summary || 'Session completed.',
    triggerType: r.trigger_type ?? null,
    triggerIntensity: r.trigger_intensity ?? null,
    outcome: e.metadata?.outcome ?? r.outcome ?? null,
    emotionalArc: r.emotional_arc || {},
    whatHelped: r.what_helped || [],
    whatDidntHelp: r.what_didnt_help || [],
    nextSessionHint: r.next_session_hint ?? null,
    preferences: {
      ...(r.preferences || {}),
      key_facts_learned: r.key_facts_learned ?? r.preferences?.key_facts_learned ?? null,
      trackable_metrics: r.trackable_metrics ?? r.preferences?.trackable_metrics ?? null,
    },
  };
}

/** Streak + resist-rate math — the one place this is computed. Outcomes must
 *  be ordered newest-first for the streak count-back to be correct. */
export function computeStreakAndRate(outcomesNewestFirst: (string | null | undefined)[]): {
  streak: number;
  resistRate: number;
} {
  const outcomes = outcomesNewestFirst.filter(Boolean) as string[];
  const resisted = outcomes.filter((o) => o === 'resisted').length;
  const resistRate = outcomes.length > 0 ? Math.round((resisted / outcomes.length) * 100) : 0;

  let streak = 0;
  for (const o of outcomes) {
    if (o === 'resisted') streak++;
    else break;
  }

  return { streak, resistRate };
}

/** "1 session" / "2 sessions" — the shared pluralization fix. */
export function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

async function fetchEvents(userId: string, eventTypes: string, limit: number): Promise<any[]> {
  try {
    const res = await fetch(
      `${ApiConfig.CHAT_URL}/events?userId=${encodeURIComponent(userId)}&eventTypes=${eventTypes}&limit=${limit}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.events || [];
  } catch {
    return [];
  }
}

const EMPTY_STATS: SessionStats = {
  sessions: [],
  reports: [],
  totalSessions: 0,
  streak: 0,
  resistRate: 0,
  preferredMode: null,
};

/**
 * Fetches session + session_report events for a user and derives the counts
 * every screen needs. Sessions come back newest-first from the server, which
 * this relies on for the streak calculation.
 */
export async function fetchSessionStats(userId: string | null): Promise<SessionStats> {
  if (!userId) return EMPTY_STATS;

  const [sessionEvents, reportEvents] = await Promise.all([
    fetchEvents(userId, 'session', 100),
    fetchEvents(userId, 'session_report', 20),
  ]);

  const sessions = sessionEvents.map(mapSessionEvent);
  const reports = reportEvents.map(mapReportEvent);

  const { streak, resistRate } = computeStreakAndRate(sessions.map((s) => s.outcome));

  const textCount = sessions.filter((s) => s.mode === 'text').length;
  const voiceCount = sessions.filter((s) => s.mode === 'voice').length;
  const preferredMode =
    textCount > voiceCount * 1.5 ? 'text' : voiceCount > textCount * 1.5 ? 'voice' : null;

  return {
    sessions,
    reports,
    totalSessions: sessions.length,
    streak,
    resistRate,
    preferredMode,
  };
}
