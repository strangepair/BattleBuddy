/**
 * Deduplication helper for client_events log entries.
 *
 * Before inserting a new client_events row, call findDuplicate() to check
 * whether an identical (user_id, event_type) entry already exists within the
 * configured time window.  If one is found, return it instead of inserting.
 *
 * Configuration:
 *   LOG_DEDUP_WINDOW_SECONDS — env var, default 90.
 */

export const LOG_DEDUP_WINDOW_SECONDS = parseInt(
  process.env.LOG_DEDUP_WINDOW_SECONDS || '90',
  10,
);

export const ACTIVITY_DEDUP_WINDOW_SECONDS = parseInt(
  process.env.ACTIVITY_DEDUP_WINDOW_SECONDS || '60',
  10,
);

/**
 * Look for an existing client_events row with the same user_id and event_type
 * whose created_at falls within the last LOG_DEDUP_WINDOW_SECONDS seconds.
 *
 * @param {object} supabase   - Supabase client
 * @param {string} userId
 * @param {string} eventType
 * @param {number} [windowSeconds] - override the default window (for testing)
 * @returns {Promise<object|null>} existing row or null if none found
 */
export async function findDuplicate(supabase, userId, eventType, windowSeconds = LOG_DEDUP_WINDOW_SECONDS) {
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();

  const { data, error } = await supabase
    .from('client_events')
    .select('id, user_id, session_id, event_type, payload, created_at')
    .eq('user_id', userId)
    .eq('event_type', eventType)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[deduplicate] query error:', error.message);
    return null;
  }

  return data || null;
}

/**
 * Look for an existing activities row with the same user_id and activity_name
 * whose created_at falls within the last ACTIVITY_DEDUP_WINDOW_SECONDS seconds.
 *
 * @param {object} supabase   - Supabase client
 * @param {string} userId
 * @param {string} activityName
 * @param {number} [windowSeconds] - override the default window (for testing)
 * @returns {Promise<object|null>} existing row or null if none found
 */
export async function findActivityDuplicate(supabase, userId, activityName, windowSeconds = ACTIVITY_DEDUP_WINDOW_SECONDS) {
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();

  const { data, error } = await supabase
    .from('activities')
    .select('id, user_id, activity_name, start_time, created_at')
    .eq('user_id', userId)
    .eq('activity_name', activityName)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[deduplicate] activities query error:', error.message);
    return null;
  }

  return data || null;
}
