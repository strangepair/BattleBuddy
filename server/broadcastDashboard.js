/**
 * broadcastDashboard.js — reusable helper that fires a dashboard:update SSE
 * event after a new bb_events row is persisted.
 *
 * Callers: the log_event tool handler in index.js.
 * Never throws — broadcast failures must not disrupt the main request path.
 */

import { broadcastToUser } from './broadcast.js';
import { deriveUsageFacts } from './usageFacts.js';

/**
 * Recompute today's cigarette count and current gap from the DB, then push a
 * dashboard:update SSE event to all open connections for this user.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId  - resolved (non-aliased) user ID
 * @param {object} newEvent - the freshly inserted bb_events row (at minimum { id, event_type, occurred_at })
 * @param {string} timezone - IANA zone string for the user
 */
export async function broadcastDashboardUpdate(supabase, userId, newEvent, timezone) {
  try {
    const { data: rows, error } = await supabase
      .from('bb_events')
      .select('event_type, occurred_at, metadata')
      .eq('user_id', userId)
      .order('occurred_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('[broadcastDashboard] fetch error:', error.message);
      return;
    }

    const facts = deriveUsageFacts(rows || [], timezone);

    broadcastToUser(userId, 'dashboard:update', {
      event: {
        id: newEvent.id,
        event_type: newEvent.event_type,
        occurred_at: newEvent.occurred_at,
      },
      today_count: facts.today_cigarette_count,
      current_gap_minutes: facts.minutes_since_last_cigarette,
    });
  } catch (err) {
    console.error('[broadcastDashboard] unexpected error:', err.message);
  }
}
