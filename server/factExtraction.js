/**
 * Extraction → fact proposals (Phase 1 shadow writes).
 *
 * analyzeAndUpdate's Sonnet output keeps mutating the profile exactly as
 * today; this module additionally translates that same output into fact
 * proposals for the merge gate. The translation reuses the one
 * profile-shape→facts mapping that already exists (factBackfill's
 * deriveFactsFromProfile) — the extraction "updates" object is a partial
 * profile, so the field routing stays defined in exactly one place.
 *
 * What deliberately does NOT flow here: activity_log (ledger's job),
 * session_summary / next_session_hints / recent_insights / user_quotes /
 * life_context (episodic texture, not canonical facts).
 */

import { deriveFactsFromProfile } from './factBackfill.js';

/** Extraction fields that must never become canonical facts. */
const EXCLUDED_FIELDS = new Set([
  'activity_log', 'session_summary', 'next_session_hints', 'recent_insights',
  'user_quotes', 'life_context', 'resolved_unknowns', 'session_outcomes',
  'daily_summaries', 'session_history', 'emotional_patterns',
]);

/**
 * Build gate-ready proposals from one extraction cycle's updates.
 * Pure: grounding quotes are attached later by the gate (groundProposals)
 * against the conversation window.
 *
 * @param {object} updates - analyzeAndUpdate's parsed output
 * @returns {Array<{category, key, value, detail, confidence, evidence, source}>}
 */
export function proposalsFromExtraction(updates) {
  if (!updates || typeof updates !== 'object') return [];

  const partial = {};
  for (const [field, value] of Object.entries(updates)) {
    if (EXCLUDED_FIELDS.has(field)) continue;
    partial[field] = value;
  }
  if (Object.keys(partial).length === 0) return [];

  // The deriver reads risk windows enriched by schedule_model — hand it the
  // same partial-profile shape it expects.
  return deriveFactsFromProfile(partial).map(p => ({
    ...p,
    source: 'extraction',
    // Extraction can never confer more than the deriver's per-entry judgment,
    // and never 'confirmed' — only the user (or a second independent
    // sighting via the gate's strengthen path) raises confidence.
    confidence: p.confidence === 'confirmed' ? 'observed' : p.confidence,
  }));
}
