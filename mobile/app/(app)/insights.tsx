/*
 * AUDIT SUMMARY — insights.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * STALE  insights list  – fetchInsights → GET /insights on bb-server, but
 *                         the /insights endpoint does not yet exist on the
 *                         server (see statsService.ts comment). When the fetch
 *                         fails or userId is null, PLACEHOLDER_INSIGHTS
 *                         (hardcoded fictional data) is returned and rendered.
 *                         Replaced the rendered list with a placeholder message
 *                         until the backend endpoint ships.
 * ─────────────────────────────────────────────────────────────────────────────
 * REMOVED  InsightCards render path — replaced with <Text>Stat unavailable</Text>
 *          until GET /insights is implemented on bb-server.
 */
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';
// AUDIT: stale – /insights backend endpoint not yet implemented; fetchInsights
// falls back to PLACEHOLDER_INSIGHTS (hardcoded fictional data) for all users.
// Entire data-fetch removed for this pass; screen now shows the same empty
// state until the real endpoint ships.
export default function InsightsScreen() {
  return (
    <ScreenWithEntity title="Insights">
      <EmptyState
        icon="sparkles-outline"
        title="Insights are coming"
        body="After enough sessions, Buddy starts noticing patterns worth naming — those observations will show up here, in BB's own voice."
      />
    </ScreenWithEntity>
  );
}
