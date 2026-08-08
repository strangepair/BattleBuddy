/**
 * Timeline CRUD tools — read, correct and delete entries in the `activities`
 * log the mission dashboard calendar renders.
 *
 * `log_activity` (in index.js) already covered CREATE. What was missing was
 * everything after: a mistyped label, an activity logged an hour off, a
 * duration that never got its end time, an entry that should not exist. The
 * only repair path was the database. These three tools close the loop.
 *
 * ── Timezone contract (the bug this module must not reintroduce) ────────────
 *
 * `activities.start_time` / `end_time` are timestamptz. A model-authored time
 * arrives as an offset-less LOCAL wall clock ("2026-08-01T14:30:00"); stored
 * raw, Postgres reads it as UTC and the whole entry slides by the user's entire
 * offset. Every write here goes through normalizeOccurredAt(value, timezone) —
 * the same helper POST /logs/activity and the log_activity tool use — so all
 * four write paths share one contract.
 *
 * One asymmetry is deliberate: normalizeOccurredAt(undefined) means "now", so
 * an omitted field on an UPDATE must mean "leave it alone", never "stamp now".
 * Only keys actually present in the patch are touched.
 *
 * No module-scope client construction — `supabase` is injected. A top-level
 * createClient() that throws kills the process during ESM evaluation, before
 * index.js's uncaughtException handler exists; that is the class of crash the
 * container-boot gate guards.
 */

import { DEFAULT_TZ, normalizeOccurredAt, formatEventTimeLocal, dayRangeInTz, localDateInTz } from './timeContext.js';

export const TIMELINE_TOOLS = [
  {
    name: 'list_activities',
    description:
      "List the activities logged for a day — what the user did and when, as the mission dashboard calendar shows it. Use for 'what did I do today', 'what's on my calendar', 'when did I go to the gym', or before correcting an entry (you need the id). Returns each entry's id, name, local start/end time and duration. Read the returned local times back to the user; never the raw UTC values.",
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: "Day to list in YYYY-MM-DD format, or 'today'. Defaults to today when omitted.",
        },
        limit: {
          type: 'integer',
          description: 'Max entries to return (default 50, max 100).',
        },
      },
      required: [],
    },
  },
  {
    name: 'update_activity',
    description:
      "Correct an activity already in the log — fix a wrong time, a wrong label, or add the end time that closes an open activity. Use this when the user says something was logged wrong ('that was 2pm not 3pm', 'that was lunch, not gym', 'I finished at 4') and when they report finishing an activity you logged the start of earlier — update that entry rather than calling log_activity again, which would create a second, separate activity. Find the id with list_activities first. Pass only the fields that change. Times are the user's LOCAL wall clock exactly as stated (e.g. '2026-08-01T14:30:00') — never convert to UTC. Confirm what you changed in one sentence.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the activity, from list_activities.' },
        activity_name: { type: 'string', description: "Corrected label, e.g. 'lunch', 'gym'." },
        start_time: {
          type: 'string',
          description:
            "Corrected start, as the user's LOCAL wall-clock time, e.g. '2026-08-01T14:30:00'. No timezone conversion, no UTC offset. Omit to leave the start unchanged.",
        },
        end_time: {
          type: 'string',
          description:
            "End time, same LOCAL wall-clock format — this is how an activity gets its duration. Omit to leave it unchanged.",
        },
        location: { type: 'string', description: "Corrected location label, e.g. 'home', 'office'." },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_activity',
    description:
      "Delete an activity from the log entirely. Use only when the user says an entry should not be there at all — a mislog, a duplicate, something that never happened. If they instead want it changed, use update_activity. Find the id with list_activities first, make sure it is the entry they mean, and confirm what you removed. This cannot be undone.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the activity to delete, from list_activities.' },
      },
      required: ['id'],
    },
  },
];

export const TIMELINE_TOOL_NAMES = new Set(TIMELINE_TOOLS.map((t) => t.name));

/** Minutes between two instants, or null when the activity is still open. */
function durationMinutes(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

/** What the model may read back. `local_time` is the sayable one; the raw
 * timestamptz values ride along for reference only, same contract as
 * log_event / get_usage_stats. */
function slimActivityForModel(r, timezone) {
  return {
    id: r.id,
    activity_name: r.activity_name,
    local_time: formatEventTimeLocal(r.start_time, timezone),
    end_local_time: r.end_time ? formatEventTimeLocal(r.end_time, timezone) : null,
    duration_minutes: durationMinutes(r.start_time, r.end_time),
    location: r.location ?? null,
    start_time: r.start_time,
    end_time: r.end_time ?? null,
  };
}

/**
 * Run one timeline tool.
 *
 * @param {string} name
 * @param {object} input
 * @param {{supabase: object|null, userId: string|null, timezone?: string}} deps
 * @returns {Promise<{content: object, is_error?: boolean}>}
 */
export async function executeTimelineTool(name, input = {}, deps = {}) {
  const { supabase, userId = null, timezone = DEFAULT_TZ } = deps;

  if (!supabase) return { content: { error: 'Event store unavailable' }, is_error: true };
  if (!userId) return { content: { error: 'No user in context' }, is_error: true };

  if (name === 'list_activities') {
    const limit = Math.min(Math.max(parseInt(input.limit, 10) || 50, 1), 100);
    const raw = input.date;
    const date = !raw || raw === 'today' ? localDateInTz(timezone) : raw;
    const { start, end } = dayRangeInTz(date, timezone);

    const { data, error } = await supabase
      .from('activities')
      .select('id, activity_name, start_time, end_time, location')
      .eq('user_id', userId)
      .gte('start_time', start.toISOString())
      .lte('start_time', end.toISOString())
      .order('start_time', { ascending: true })
      .limit(limit);

    if (error) return { content: { error: error.message }, is_error: true };
    const activities = (data || []).map((r) => slimActivityForModel(r, timezone));
    return { content: { date, count: activities.length, activities } };
  }

  if (name === 'update_activity') {
    const { id } = input;
    if (!id) return { content: { error: 'id is required' }, is_error: true };

    // Ownership is checked by reading the row scoped to this user first: the
    // service-role client bypasses RLS, so a bare .eq('id', …) update would be
    // able to touch another user's entry if an id ever leaked into a prompt.
    const { data: existing, error: readErr } = await supabase
      .from('activities')
      .select('id, activity_name, start_time, end_time, location')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (readErr || !existing) return { content: { error: 'activity not found' }, is_error: true };

    // Only fields actually supplied are touched. normalizeOccurredAt(undefined)
    // returns NOW, so a blanket normalize of every key would silently re-stamp
    // an untouched start_time to the current time on a label-only correction.
    const updates = {};
    const has = (k) => input[k] !== undefined && input[k] !== null && input[k] !== '';
    if (has('activity_name')) updates.activity_name = String(input.activity_name);
    if (has('start_time')) updates.start_time = normalizeOccurredAt(input.start_time, timezone);
    if (has('end_time')) updates.end_time = normalizeOccurredAt(input.end_time, timezone);
    if (has('location')) updates.location = String(input.location);

    if (Object.keys(updates).length === 0) {
      return { content: { error: 'nothing to update — pass at least one field to change' }, is_error: true };
    }

    // An end before its start is a mis-parse, not an edit. Rejecting it here
    // keeps the calendar from rendering a negative-length block.
    const finalStart = updates.start_time || existing.start_time;
    const finalEnd = updates.end_time || existing.end_time;
    if (finalStart && finalEnd && new Date(finalEnd).getTime() < new Date(finalStart).getTime()) {
      return {
        content: {
          error: 'end_time is before start_time',
          meaning: 'Ask the user to clarify the times rather than guessing which one is wrong.',
        },
        is_error: true,
      };
    }

    const { data, error } = await supabase
      .from('activities')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, activity_name, start_time, end_time, location')
      .single();
    if (error) return { content: { error: error.message }, is_error: true };

    return {
      content: {
        ok: true,
        updated: Object.keys(updates),
        activity: slimActivityForModel(data, timezone),
      },
    };
  }

  if (name === 'delete_activity') {
    const { id } = input;
    if (!id) return { content: { error: 'id is required' }, is_error: true };

    // Read before delete so the confirmation can name what went, and so a
    // wrong/foreign id fails as "not found" instead of silently deleting zero
    // rows and reporting success.
    const { data: existing } = await supabase
      .from('activities')
      .select('id, activity_name, start_time, end_time, location')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (!existing) return { content: { error: 'activity not found' }, is_error: true };

    const { error } = await supabase.from('activities').delete().eq('id', id).eq('user_id', userId);
    if (error) return { content: { error: error.message }, is_error: true };

    return { content: { ok: true, deleted: id, activity: slimActivityForModel(existing, timezone) } };
  }

  return { content: { error: `Unknown timeline tool: ${name}` }, is_error: true };
}
