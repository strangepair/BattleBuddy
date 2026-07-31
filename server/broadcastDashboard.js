/**
 * broadcastDashboard.js — dashboard-specific SSE helper.
 *
 * This is the SOLE emitter for `dashboard:update` events. Both the POST /events
 * handler and the log_event tool handler call `broadcastDashboard(userId, payload)`
 * here — nowhere else builds or emits `dashboard:update`.
 *
 * broadcast.js is the generic SSE transport; this file is the dashboard-specific
 * adapter that enforces the canonical payload contract.
 *
 * Canonical payload contract:
 *   {
 *     event: { id, instant, activityLabel, location },
 *     todayCount, currentGapMinutes, longestGapTodayMinutes
 *   }
 *
 * Never throws — broadcast failures must not disrupt the main request path.
 */

import { broadcastToUser } from './broadcast.js';

/**
 * Emit a `dashboard:update` SSE event to all open connections for a user.
 *
 * @param {string} userId - resolved (non-aliased) user ID
 * @param {object} derivedPayload - output of deriveDashboardPayload(); must
 *   contain todayEntries (array), todayCount, currentGapMinutes,
 *   longestGapTodayMinutes.  The most-recent entry in todayEntries is used as
 *   the `event` field so clients can merge it into their local state without a
 *   full refetch.
 */
export function broadcastDashboard(userId, derivedPayload) {
  try {
    const { todayEntries, todayCount, currentGapMinutes, longestGapTodayMinutes } = derivedPayload;

    const lastEntry = Array.isArray(todayEntries) && todayEntries.length > 0
      ? todayEntries[todayEntries.length - 1]
      : null;

    broadcastToUser(userId, 'dashboard:update', {
      event: lastEntry
        ? {
            id: lastEntry.id,
            instant: lastEntry.instant,
            activityLabel: lastEntry.activityLabel ?? null,
            location: lastEntry.location ?? null,
          }
        : null,
      todayCount: todayCount ?? 0,
      currentGapMinutes: currentGapMinutes ?? null,
      longestGapTodayMinutes: longestGapTodayMinutes ?? 0,
    });
  } catch (err) {
    console.error('[broadcastDashboard] unexpected error:', err.message);
  }
}
