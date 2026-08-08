/**
 * Time context — the single place where "what time is it for the user" is
 * computed and where model-supplied timestamps are normalized into instants.
 *
 * Two failure modes motivated pulling this out of index.js:
 *  1. UTC bleed: any formatter that omits `timeZone` renders the SERVER clock
 *     (Railway runs UTC), and the model states it to the user as local time.
 *  2. Fabricated instants: the model authors `occurred_at` strings itself; an
 *     offset-less ISO string ("2026-07-29T16:43:00") stored raw is read as
 *     UTC downstream, shifting every event by the user's whole offset.
 *
 * Everything here takes the timezone explicitly and is pure given (input, tz,
 * now), so it can be tested under TZ=UTC — the exact prod condition.
 */

export const DEFAULT_TZ = 'America/Chicago';

/** "GMT-05:00"-style offset of a timezone at an instant, as "±HH:MM". */
export function tzOffsetString(timezone = DEFAULT_TZ, at = new Date()) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at).find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00';
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return '+00:00';
    return `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}`;
  } catch {
    return '+00:00';
  }
}

/**
 * The user's current wall clock, e.g. "Wednesday, 4:43 PM, July 29, 2026".
 * An unknown/invalid timezone falls back to DEFAULT_TZ — never to the server's
 * own locale clock, which is UTC in prod and would be stated as local.
 */
export function formatLocalTime(timezone, at = new Date()) {
  const render = (tz) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'long', day: 'numeric',
    });
    return `${formatter.format(at)}, ${dateFormatter.format(at)}`;
  };
  try {
    return render(timezone || DEFAULT_TZ);
  } catch {
    return render(DEFAULT_TZ);
  }
}

/** The user's local calendar date (YYYY-MM-DD) at an instant. */
export function localDateInTz(timezone = DEFAULT_TZ, at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** UTC start/end instants of a local calendar day (YYYY-MM-DD) in a timezone. */
export function dayRangeInTz(dateStr, timezone = DEFAULT_TZ) {
  const offset = tzOffsetString(timezone, new Date(`${dateStr}T12:00:00Z`));
  const start = new Date(`${dateStr}T00:00:00${offset}`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000 - 1);
  return { start, end };
}

// Render a stored UTC instant as a human-readable time IN THE USER'S TIMEZONE.
// Everything in bb_events is UTC; the model must never see a bare `...Z` string
// or it reports UTC clock times back to the user. Attach this alongside every
// event/summary time the model can read.
export function formatEventTimeLocal(iso, timezone = DEFAULT_TZ) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || DEFAULT_TZ,
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

/**
 * Session-continuity line for the system prompt. The clock time is rendered in
 * the USER's timezone — the omitted-timeZone formatter this replaces rendered
 * the server's UTC clock ("last session at 9:43 PM" for a 4:43 PM session),
 * which the model then repeated to the user as a remembered local time.
 */
export function buildSessionContext(profile, timezone = DEFAULT_TZ, now = Date.now(), gapPhraseFn) {
  if (!profile || !profile.last_session_at) {
    return 'This is the first session with this user.';
  }

  const lastAt = new Date(profile.last_session_at).getTime();
  const gapMinutes = Math.floor((now - lastAt) / 60000);
  const gapDays = Math.floor(gapMinutes / 1440);

  const gapStr = gapPhraseFn ? gapPhraseFn(lastAt, now) : null;

  let lastTimeStr = '';
  try {
    lastTimeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || DEFAULT_TZ,
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(profile.last_session_at));
  } catch {}

  let context = `Last session: ${gapStr}`;
  if (lastTimeStr && gapDays >= 1) context += ` (at ${lastTimeStr})`;
  context += '.';

  if (gapMinutes < 30) {
    context += ' This is a continuation of the same conversation — skip the greeting and pick up where you left off.';
  }

  return context;
}

/**
 * Normalize a model- or client-supplied `occurred_at` into a trustworthy ISO
 * instant for storage.
 *
 *  - empty/absent      → now (the server clock is the authority for "right now";
 *                        the model must never author the current time)
 *  - explicit Z/offset → taken as the instant it states
 *  - offset-less ISO   → interpreted as wall-clock time IN THE USER'S TIMEZONE
 *                        (models think in the user's local time; parsing these
 *                        as UTC is how a 4:43 PM cigarette became 11:43 AM)
 *  - unparseable       → now
 *  - future            → clamped to now: events happen in the past, so a
 *                        future timestamp is by definition a fabricated clock
 *                        (2-minute skew allowance for client clocks)
 */
export function normalizeOccurredAt(input, timezone = DEFAULT_TZ, now = new Date()) {
  const nowIso = now.toISOString();
  if (!input || typeof input !== 'string' || !input.trim()) return nowIso;
  const s = input.trim();

  let d;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    d = new Date(s);
  } else {
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
    if (m) {
      const offset = tzOffsetString(timezone, new Date(`${m[1]}T12:00:00Z`));
      d = new Date(`${m[1]}T${m[2].length === 4 ? '0' + m[2] : m[2]}${offset}`);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      // Date-only back-log: anchor mid-day local so the local calendar day is
      // preserved through any later day-bucketing.
      const offset = tzOffsetString(timezone, new Date(`${s}T12:00:00Z`));
      d = new Date(`${s}T12:00:00${offset}`);
    } else {
      d = new Date(s);
    }
  }

  if (!d || isNaN(d.getTime())) return nowIso;
  if (d.getTime() > now.getTime() + 2 * 60 * 1000) return nowIso;
  return d.toISOString();
}

// Deploy nudge 2026-07-29: GitHub dropped the push event for merge 4119eb7
// (PR #27); this line exists only to re-fire the path-filtered deploy.
