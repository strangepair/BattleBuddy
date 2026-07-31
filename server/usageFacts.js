/**
 * Usage facts — the single deterministic source for "how many cigarettes
 * today / when was the last one / how long has it been".
 *
 * Why this exists: BB was answering count/time/gap questions from whatever
 * happened to be in context — a stale profile-blob tally, a 128 KB tool
 * payload dominated by session_report blobs, or plain conversational memory —
 * and told Mike "one today" while bb_events held five rows (2026-07-29).
 * Every consumer (text per-turn injection, voice per-turn injection,
 * get_usage_stats, /context/stats) now reports numbers derived HERE, from
 * bb_events rows, in the user's timezone.
 *
 * Pure given (rows, timezone, now) so it tests under TZ=UTC — the exact prod
 * condition (Railway runs UTC; see timeContext.js for the ground rules).
 */

import { DEFAULT_TZ } from './timeContext.js';

/** The event types that are actual habit data. Everything else in bb_events
 * (session_report, transcript_audit, session, ...) is machinery and must
 * never reach the model through a usage query. */
export const HABIT_EVENT_TYPES = ['cigarette', 'urge', 'urge_resisted', 'urge_gave_in', 'decision', 'milestone'];

function localDateOf(iso, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

function localClockOf(iso, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

function shortNote(metadata) {
  const raw = metadata?.notes || metadata?.trigger?.label || null;
  if (!raw) return null;
  const s = String(raw).trim();
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/**
 * Derive the ground-truth usage facts from event rows.
 *
 * @param {Array} rows - bb_events rows ({ event_type, occurred_at, metadata }),
 *   any order; may span multiple days — bucketing into "today" happens here,
 *   in the user's timezone, never the server's.
 * @param {string} timezone - IANA zone of the user
 * @param {Date} now - injected for testability
 */
export function deriveUsageFacts(rows, timezone = DEFAULT_TZ, now = new Date()) {
  const tz = timezone || DEFAULT_TZ;
  const today = localDateOf(now.toISOString(), tz);

  const habit = (rows || [])
    .filter(r => HABIT_EVENT_TYPES.includes(r.event_type))
    .filter(r => r.occurred_at && new Date(r.occurred_at).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

  const todayRows = habit.filter(r => localDateOf(r.occurred_at, tz) === today);
  const todayCigs = todayRows.filter(r => r.event_type === 'cigarette');

  // Last cigarette EVER seen in the provided rows, not just today — after
  // midnight the honest answer is "yesterday at 11 PM", not "none today".
  const allCigs = habit.filter(r => r.event_type === 'cigarette');
  const lastCig = allCigs.length ? allCigs[allCigs.length - 1] : null;

  const minutesSince = lastCig
    ? Math.max(0, Math.round((now.getTime() - new Date(lastCig.occurred_at).getTime()) / 60000))
    : null;

  return {
    date: today,
    timezone: tz,
    today_cigarette_count: todayCigs.length,
    today_urges_resisted: todayRows.filter(r => r.event_type === 'urge_resisted').length,
    today_urges_gave_in: todayRows.filter(r => r.event_type === 'urge_gave_in').length,
    last_cigarette_at: lastCig?.occurred_at || null,
    last_cigarette_local: lastCig ? localClockOf(lastCig.occurred_at, tz) : null,
    last_cigarette_date: lastCig ? localDateOf(lastCig.occurred_at, tz) : null,
    minutes_since_last_cigarette: minutesSince,
    today_log: todayRows.map(r => ({
      event_type: r.event_type,
      local_time: localClockOf(r.occurred_at, tz),
      note: shortNote(r.metadata),
    })),
  };
}

/**
 * Derive the dashboard payload from bb_events rows.
 *
 * Returns the canonical shape consumed by both GET /dashboard/today and
 * broadcastDashboard — a single source of truth for all dashboard consumers.
 *
 * @param {Array} rows - bb_events rows ({ id, event_type, occurred_at, metadata }),
 *   any order; may span multiple days.
 * @param {string} timezone - IANA zone of the user
 * @param {Date} now - injected for testability
 */
export function deriveDashboardPayload(rows, timezone = DEFAULT_TZ, now = new Date()) {
  const tz = timezone || DEFAULT_TZ;
  const today = localDateOf(now.toISOString(), tz);

  const allRows = (rows || [])
    .filter(r => r.occurred_at && new Date(r.occurred_at).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

  const todayCigRows = allRows.filter(
    r => r.event_type === 'cigarette' && localDateOf(r.occurred_at, tz) === today,
  );

  const todayEntries = todayCigRows.map(r => ({
    id: r.id,
    instant: r.occurred_at,
    activityLabel: r.metadata?.trigger?.label || r.metadata?.notes || null,
    location: r.metadata?.location || null,
  }));

  const todayCount = todayCigRows.length;

  const lastCig = todayCigRows.length ? todayCigRows[todayCigRows.length - 1] : null;
  const currentGapMinutes = lastCig
    ? Math.max(0, Math.round((now.getTime() - new Date(lastCig.occurred_at).getTime()) / 60000))
    : null;

  let longestGapTodayMinutes = 0;
  for (let i = 1; i < todayCigRows.length; i++) {
    const gap = Math.round(
      (new Date(todayCigRows[i].occurred_at) - new Date(todayCigRows[i - 1].occurred_at)) / 60000,
    );
    if (gap > longestGapTodayMinutes) longestGapTodayMinutes = gap;
  }

  const seenDates = new Set();
  seenDates.add(today);
  const recentHistory = allRows
    .filter(r => r.event_type === 'cigarette')
    .filter(r => {
      const d = localDateOf(r.occurred_at, tz);
      if (seenDates.has(d) && d === today) return false;
      seenDates.add(d);
      return true;
    })
    .map(r => ({
      id: r.id,
      instant: r.occurred_at,
      activityLabel: r.metadata?.trigger?.label || r.metadata?.notes || null,
      location: r.metadata?.location || null,
    }));

  return {
    todayEntries,
    todayCount,
    currentGapMinutes,
    longestGapTodayMinutes,
    recentHistory,
  };
}

function gapPhrase(minutes) {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes} minutes ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m ago` : `${h} hours ago`;
}

/**
 * Render the facts as the per-turn injection line. This line — or a
 * get_usage_stats result — is the ONLY place BB may take counts, times,
 * and gaps from; the sentence says so explicitly because the model reads it.
 */
export function renderUsageFactsLine(facts) {
  if (!facts) return null;
  const parts = [];
  parts.push(
    `LOGGED CIGARETTE FACTS (server-computed from the event log — the ONLY valid source for counts, times, and gaps): ` +
    `today (${facts.date}): ${facts.today_cigarette_count} cigarette${facts.today_cigarette_count === 1 ? '' : 's'} logged.`
  );
  if (facts.last_cigarette_local) {
    const when = facts.last_cigarette_date === facts.date
      ? `${facts.last_cigarette_local} today`
      : `${facts.last_cigarette_local} on ${facts.last_cigarette_date}`;
    parts.push(`Last cigarette: ${when} (${gapPhrase(facts.minutes_since_last_cigarette)}).`);
  } else {
    parts.push('No cigarettes in the log yet.');
  }
  const cigTimes = facts.today_log
    .filter(e => e.event_type === 'cigarette')
    .map(e => e.note ? `${e.local_time} (${e.note})` : e.local_time);
  if (cigTimes.length) parts.push(`Today's cigarettes: ${cigTimes.join(', ')}.`);
  if (facts.today_urges_resisted > 0) parts.push(`Urges resisted today: ${facts.today_urges_resisted}.`);
  parts.push('When asked about any count, time, or gap, report exactly these values (or a fresh get_usage_stats result) — never count from conversation memory, never estimate, never carry numbers over from earlier turns.');
  return parts.join(' ');
}
