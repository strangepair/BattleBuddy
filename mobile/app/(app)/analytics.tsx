/*
 * AUDIT SUMMARY — analytics.tsx  (Journey screen)
 * ─────────────────────────────────────────────────────────────────────────────
 * STALE  ArcChart          – fetchJourney → GET /stats/journey; endpoint not
 *                            yet implemented on bb-server (see statsService.ts
 *                            comment). Falls back to PLACEHOLDER_JOURNEY
 *                            (hardcoded fictional data) on any fetch failure.
 *                            Replaced with <Text>Stat unavailable</Text>.
 * STALE  HoursHeatmap      – same fetchJourney call / same fallback.
 *                            Replaced with <Text>Stat unavailable</Text>.
 * STALE  WhatWorksList     – same fetchJourney call / same fallback.
 *                            Replaced with <Text>Stat unavailable</Text>.
 * STALE  IndependenceTrend – same fetchJourney call / same fallback.
 *                            Replaced with <Text>Stat unavailable</Text>.
 * STALE  InsightCards      – fetchInsights → GET /insights; endpoint not yet
 *                            implemented (see statsService.ts comment). Falls
 *                            back to PLACEHOLDER_INSIGHTS.
 *                            Replaced with <Text>Stat unavailable</Text>.
 * ─────────────────────────────────────────────────────────────────────────────
 * REMOVED  All chart/insight components — screen now shows a single empty
 *          state until GET /stats/journey and GET /insights ship on bb-server.
 */
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';

// AUDIT: stale – fetchJourney and fetchInsights both fall back to hardcoded
// PLACEHOLDER_* data because /stats/journey and /insights do not yet exist on
// bb-server (statsService.ts). All chart components removed for this pass.
export default function JourneyScreen() {
  return (
    <ScreenWithEntity title="Journey">
      <EmptyState
        icon="pulse-outline"
        title="Your journey is loading up"
        body="Charts and patterns will appear here once you've had a few sessions with Buddy."
      />
    </ScreenWithEntity>
  );
}
