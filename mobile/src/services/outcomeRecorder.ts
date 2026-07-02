import { ApiConfig } from '../config';
import type { SessionMessage, SessionOutcome } from '../stores/sessionStore';
import { logEvent } from './eventService';

export interface SessionResult {
  userId: string | null;
  sessionId: string;
  mode: string;
  outcome: SessionOutcome;
  helped: boolean;
  startedAt: number;
  endedAt: number;
  triggerContext: TriggerContext | null;
  messages: SessionMessage[];
  intensityStart: number | null;
  intensityEnd: number | null;
  /** True only when the session actually ended (not a background checkpoint).
   *  Drives server-side session_count + session summary extraction. */
  finalize?: boolean;
}

export interface TriggerContext {
  trigger: string;
  intensity: number;
  time: string;
}

function getTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'America/Chicago';
  }
}

async function resolveUserId(explicit: string | null): Promise<string | null> {
  if (explicit) return explicit;
  try {
    const { useAuthStore } = await import('../stores/authStore');
    return useAuthStore.getState().user?.id ?? null;
  } catch {
    return null;
  }
}

// All session persistence goes through the server (service role) — the old
// direct-to-Supabase writes could never pass RLS with local user ids and
// silently dropped every row.
export async function recordOutcome(result: SessionResult): Promise<void> {
  const userId = await resolveUserId(result.userId);
  const nonEmpty = result.messages.filter((m) => m.content.length > 0);

  // Finalize text sessions into the memory pipeline: session_count, session
  // history, and fact extraction. Voice sessions are finalized by the voice
  // agent itself — sending again would double-count.
  if (result.finalize && result.mode !== 'voice' && nonEmpty.length >= 2) {
    try {
      await fetch(`${ApiConfig.CHAT_URL}/context/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          sessionId: result.sessionId,
          messages: nonEmpty.map((m) => ({ role: m.role, content: m.content })),
          isSessionEnd: true,
          timezone: getTimezone(),
        }),
      });
    } catch {
      // Offline — the transcript is in SQLite and will reach the server via sync
    }
  }

  // Generate the session report (async, non-blocking)
  generateSessionReport({ ...result, userId }, null);
}

async function generateSessionReport(result: SessionResult, cravingEventId: string | null): Promise<void> {
  let nonEmptyMessages = result.messages.filter((m) => m.content.length > 0);
  if (nonEmptyMessages.length < 2) {
    console.warn('[REPORT] Skipping — fewer than 2 messages');
    return;
  }

  // Truncate to last 30 messages to avoid 500 errors on large transcripts
  if (nonEmptyMessages.length > 30) {
    nonEmptyMessages = nonEmptyMessages.slice(-30);
  }

  console.warn(`[REPORT] Generating report from ${nonEmptyMessages.length} messages...`);

  try {
    const res = await fetch(`${ApiConfig.CHAT_URL}/session/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: nonEmptyMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        outcome: result.outcome,
        triggerContext: result.triggerContext,
        sessionId: result.sessionId,
        cravingEventId,
        userId: result.userId,
      }),
    });

    if (!res.ok) {
      console.warn(`[REPORT] Server returned ${res.status}`);
      return;
    }
    const { report } = await res.json();
    if (!report) {
      console.warn('[REPORT] No report in response');
      return;
    }

    console.warn('[REPORT] Report generated, saving locally...');
    await saveReportLocally(report);
    console.warn('[REPORT] Profile updated.');
  } catch (err) {
    console.warn('[REPORT] Failed:', err);
  }
}

async function saveReportLocally(report: any): Promise<void> {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  const { useSessionStore } = await import('../stores/sessionStore');
  const { scopedKey } = await import('./scopedStorage');

  // Append to local reports list (keep last 20)
  const key = scopedKey('bb_session_reports');
  const existing = await AsyncStorage.getItem(key);
  const reports: any[] = existing ? JSON.parse(existing) : [];
  reports.unshift({ ...report, created_at: new Date().toISOString() });
  if (reports.length > 20) reports.length = 20;
  await AsyncStorage.setItem(key, JSON.stringify(reports));

  // Build an updated profile from all local reports
  const profile = buildLocalProfile(reports);
  useSessionStore.getState().setProfileSummary(profile.summary);
  useSessionStore.getState().setRecentHistory(profile.recentHistory);
}

export function buildLocalProfile(reports: any[]): { summary: string; recentHistory: string } {
  if (reports.length === 0) return { summary: 'New user — no history yet.', recentHistory: 'First session.' };

  const parts: string[] = [];

  // Extract ALL facts across all reports (most recent value wins for scalar fields)
  const facts: Record<string, string | null> = {};
  const lifeEvents: string[] = [];
  const allHelped: string[] = [];
  const copingStyles: string[] = [];

  for (const r of reports) {
    const kf = r.key_facts_learned || r.preferences?.key_facts_learned;
    if (kf) {
      // Scalar fields — first non-null wins (reports are newest-first)
      const scalarFields = [
        'name', 'preferred_name', 'age', 'location', 'occupation', 'family',
        'cigarettes_per_day', 'vapes_per_day', 'urges_per_day', 'longest_quit',
        'quit_reason', 'addiction_type', 'smoking_history', 'health_concerns',
        'previous_quit_attempts',
      ];
      for (const field of scalarFields) {
        if (kf[field] && !facts[field]) facts[field] = String(kf[field]);
      }

      if (kf.life_events) {
        for (const e of kf.life_events) {
          if (e && !lifeEvents.includes(e)) lifeEvents.push(e);
        }
      }
    }

    if (r.what_helped) {
      for (const h of r.what_helped) {
        if (h && !allHelped.includes(h)) allHelped.push(h);
      }
    }

    const style = r.preferences?.coping_style;
    if (style && !copingStyles.includes(style)) copingStyles.push(style);
  }

  // Build the profile — include everything we know
  const name = facts.preferred_name || facts.name;
  if (name) parts.push(`Name: ${name}.`);
  if (facts.age) parts.push(`Age: ${facts.age}.`);
  if (facts.occupation) parts.push(`Occupation: ${facts.occupation}.`);
  if (facts.family) parts.push(`Family: ${facts.family}.`);
  if (facts.location) parts.push(`Location: ${facts.location}.`);
  if (facts.addiction_type) parts.push(`Battling: ${facts.addiction_type}.`);
  if (facts.smoking_history) parts.push(`Nicotine history: ${facts.smoking_history}.`);
  if (facts.cigarettes_per_day) parts.push(`Baseline: ${facts.cigarettes_per_day} cigarettes/day.`);
  if (facts.vapes_per_day) parts.push(`Baseline: ${facts.vapes_per_day} vapes/day.`);
  if (facts.quit_reason) parts.push(`Reason for quitting: ${facts.quit_reason}.`);
  if (facts.health_concerns) parts.push(`Health concerns: ${facts.health_concerns}.`);
  if (facts.previous_quit_attempts) parts.push(`Previous attempts: ${facts.previous_quit_attempts}.`);
  if (lifeEvents.length > 0) parts.push(`Personal details: ${lifeEvents.slice(0, 5).join('; ')}.`);
  parts.push(`${reports.length} sessions logged.`);
  if (allHelped.length > 0) parts.push(`What works: ${allHelped.slice(0, 3).join(', ')}.`);
  if (copingStyles.length > 0) parts.push(`Preferred coping: ${copingStyles[0]}.`);
  if (facts.longest_quit) parts.push(`Longest quit: ${facts.longest_quit}.`);
  if (reports[0]?.next_session_hint) parts.push(`Hint: ${reports[0].next_session_hint}`);

  const recentHistory = reports.slice(0, 3)
    .map((r: any, i: number) => `${i === 0 ? 'Last session' : `${i + 1} sessions ago`}: ${r.summary}`)
    .join('\n');

  return { summary: parts.join(' '), recentHistory };
}

export const LAST_OUTCOME_KEY = 'bb_last_outcome';

export interface LastOutcome {
  outcome: 'resisted' | 'gave_in';
  timestamp: string;
}

export async function recordSessionOutcome(
  userId: string,
  outcome: 'resisted' | 'gave_in',
): Promise<void> {
  const timestamp = new Date().toISOString();

  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  const { scopedKey } = await import('./scopedStorage');
  await AsyncStorage.setItem(
    scopedKey(LAST_OUTCOME_KEY),
    JSON.stringify({ outcome, timestamp } satisfies LastOutcome),
  ).catch(() => {});

  try {
    await fetch(`${ApiConfig.CHAT_URL}/context/session-outcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, outcome, timestamp }),
    });
  } catch {
    // Offline — local storage already has it
  }

  if (outcome === 'resisted') {
    logEvent(userId, 'urge_resisted', {}, timestamp);
  } else {
    logEvent(userId, 'urge_gave_in', {}, timestamp);
    logEvent(userId, 'cigarette', {}, timestamp);
  }
}

