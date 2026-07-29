/**
 * Nightly fact consolidation — Phase 1 ships it REPORT-ONLY.
 *
 * Three sweeps over each user's active facts (spec §3.5):
 *   1. staleness — facts past review_after, flagged for in-conversation
 *      reconfirmation (the render already marks these; this reports them);
 *   2. near-duplicates — embedding similarity within a category, the right
 *      use of vectors: a maintenance index, not a truth oracle;
 *   3. conflict digest — unresolved CONFLICTS pairs awaiting the agent's
 *      clarifying question, surfaced to the admin console.
 *
 * mode='report' (Phase 1 default) writes the report to the volume and
 * touches nothing. mode='act' (Phase 3+, flag-gated) will route merge
 * candidates through the gate — deliberately not implemented yet.
 *
 * Scoring/selection is pure; only the sweep loop touches stores.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADMIN_DATA_ROOT } from './contextAgent.js';
import { listFactUsers, getActiveFacts } from './factStore.js';
import { isStale } from './memoryDoc.js';
import { embed } from './embeddings.js';

export const NEAR_DUP_THRESHOLD = 0.88;

export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Pure: pair up same-category facts whose value embeddings exceed the
 * threshold. Input: [{fact, vector}]. */
export function findNearDuplicates(embedded, threshold = NEAR_DUP_THRESHOLD) {
  const pairs = [];
  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      if (embedded[i].fact.category !== embedded[j].fact.category) continue;
      const sim = cosine(embedded[i].vector, embedded[j].vector);
      if (sim >= threshold) {
        pairs.push({ a: embedded[i].fact.key, b: embedded[j].fact.key, similarity: Number(sim.toFixed(3)) });
      }
    }
  }
  return pairs;
}

/** Pure: select the report rows for one user's facts. */
export function sweepUser(facts, nowMs = Date.now()) {
  return {
    stale: facts.filter(f => isStale(f, nowMs)).map(f => ({
      key: f.key, value: f.value, review_after: f.review_after, confidence: f.confidence,
    })),
    conflicts: facts.filter(f => f.conflict_with).map(f => ({
      key: f.key, value: f.value, conflict_with: f.conflict_with,
    })),
  };
}

const REPORT_PATH = resolve(ADMIN_DATA_ROOT, 'fact-consolidation-report.json');

export function readConsolidationReport() {
  try { return JSON.parse(readFileSync(REPORT_PATH, 'utf-8')); } catch { return null; }
}

/**
 * One sweep across all users with facts. Report-only: the returned/persisted
 * report is the entire output. 'act' mode is refused until Phase 3 wires it.
 */
export async function runFactConsolidation({ mode = 'report', nowMs = Date.now() } = {}) {
  if (mode !== 'report') {
    console.warn(`[FactConsolidation] mode '${mode}' not enabled yet — running report-only`);
  }

  const users = await listFactUsers();
  const report = { ran_at: new Date(nowMs).toISOString(), mode: 'report', users: {} };

  for (const userId of users) {
    try {
      const facts = await getActiveFacts(userId);
      const { stale, conflicts } = sweepUser(facts, nowMs);

      let nearDuplicates = [];
      try {
        const embedded = [];
        for (const fact of facts) {
          embedded.push({ fact, vector: await embed(fact.value) });
        }
        nearDuplicates = findNearDuplicates(embedded);
      } catch (e) {
        console.error(`[FactConsolidation] Embedding scan failed for ${userId}:`, e.message);
      }

      report.users[userId] = {
        active: facts.length,
        stale,
        conflicts,
        near_duplicates: nearDuplicates,
      };
      console.log(
        `[FactConsolidation] ${userId}: ${facts.length} active, ${stale.length} stale, ` +
        `${conflicts.length} conflict(s), ${nearDuplicates.length} near-dup pair(s)`
      );
    } catch (e) {
      console.error(`[FactConsolidation] Sweep failed for ${userId}:`, e.message);
    }
  }

  try {
    mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch (e) {
    console.error('[FactConsolidation] Report write failed:', e.message);
  }
  return report;
}
