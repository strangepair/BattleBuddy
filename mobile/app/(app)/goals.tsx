/*
 * AUDIT SUMMARY — goals.tsx  (Records screen)
 * ─────────────────────────────────────────────────────────────────────────────
 * STALE  records grid   – fetchRecords → GET /stats/records; endpoint not yet
 *                         implemented on bb-server (see statsService.ts
 *                         comment). When the fetch fails or userId is null,
 *                         PLACEHOLDER_RECORDS (hardcoded fictional dates,
 *                         values, and context strings) is returned and rendered.
 *                         Replaced all record tiles with empty state.
 * STALE  milestones list – same fetchRecords call / same PLACEHOLDER_RECORDS
 *                         fallback; hardcoded milestone titles, dates, and
 *                         detail strings rendered as if real.
 *                         Replaced milestones list with empty state.
 * STALE  newRecord       – celebration banner driven by PLACEHOLDER_RECORDS
 *                         which always includes isNew:true on longest_stretch,
 *                         so the banner (mascot + haptic) fires every mount.
 *                         Banner removed along with the records grid.
 * ─────────────────────────────────────────────────────────────────────────────
 * REMOVED  All record tiles, milestones rows, and celebration banner —
 *          screen now shows empty state until GET /stats/records ships.
 */
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';

// AUDIT: stale – fetchRecords falls back to PLACEHOLDER_RECORDS (hardcoded
// fictional data) because /stats/records does not yet exist on bb-server
// (statsService.ts). All record tiles and milestone rows removed for this pass.
export default function GoalsScreen() {
  return (
    <ScreenWithEntity title="Records">
      <EmptyState
        icon="flag-outline"
        title="Records start here"
        body="Every urge you ride out builds your personal records. They only ever get better — a slip never resets anything."
      />
    </ScreenWithEntity>
  );
}
