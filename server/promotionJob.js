/**
 * Promotion — decides which memories earn a permanent place in context.
 *
 * Reads the recall evidence recorded by migration 010 and promotes the memories
 * that keep proving useful into the always-injected tier from 009. The premise
 * is that retrieval frequency is itself the signal: nothing has to guess up
 * front which memories matter, because usage decides.
 *
 * The scoring shape (weights, gates, the log-saturating frequency term, the
 * spacing/span split in consolidation) is taken from openclaw's memory-core,
 * which had already tuned it against real usage. Reimplemented here against
 * Postgres — no dependency taken; see DECISIONS.md 2026-07-19.
 *
 * Scoring is pure and lives apart from the data access so the math can be
 * tested without a database.
 */

import { getPromotionCandidates, markPromoted } from './vectorStore.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Sum to 1.0. Relevance leads because a memory that scores well on similarity
// every time it surfaces is more trustworthy than one that surfaces often but
// only ever weakly matches.
export const PROMOTION_WEIGHTS = {
  relevance: 0.30,
  frequency: 0.24,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  conceptual: 0.06,
};

// All three gates must pass. A high score alone cannot promote — that is the
// point of the gates. Score rewards strength; gates require the evidence to be
// spread across time and context, which is what separates a durable fact about
// someone from a phrase that happened to match well during one hard night.
export const PROMOTION_GATES = {
  minScore: 0.8,
  minRecallCount: 3,
  minUniqueQueries: 3,
};

const RECENCY_HALF_LIFE_DAYS = 14;
const MAX_AGE_DAYS = 30;

// Bounds churn per sweep. The prompt itself is protected separately —
// getPromotedMemories caps what it reads — so this is about not thrashing the
// tier, not about prompt size.
export const MAX_PROMOTED_PER_USER = 10;

const clamp01 = n => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Recall keys are 'YYYY-MM-DD:<hash>' (migration 010). Days measure spacing
 * over time; hashes measure how many genuinely different contexts surfaced it.
 */
export function parseRecallKeys(keys = []) {
  const days = new Set();
  const queries = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || key.length < 11) continue;
    days.add(key.slice(0, 10));
    queries.add(key.slice(11));
  }
  return { days: [...days].sort(), queries };
}

/**
 * How well distributed the recalls were, rather than how many there were.
 *
 * A memory recalled five times across five days over a week is evidence of
 * something durable. Five recalls in one afternoon is evidence of one bad
 * afternoon. Both have recall_count = 5; only this term tells them apart.
 */
export function consolidationComponent(days) {
  if (days.length === 0) return 0;
  if (days.length === 1) return 0.2;

  const spanDays = (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / DAY_MS;
  const spacing = clamp01(Math.log1p(days.length - 1) / Math.log1p(4));
  const span = clamp01(spanDays / 7);
  return clamp01(0.55 * spacing + 0.45 * span);
}

/**
 * Score one memory. Pure — pass `nowMs` rather than reading the clock.
 *
 * @returns {{score: number, components: object, promotable: boolean, blockedBy: string[]}}
 */
export function scoreMemory(memory, nowMs = Date.now()) {
  const { days, queries } = parseRecallKeys(memory.recall_keys);
  const recallCount = memory.recall_count || 0;
  const conceptTags = memory.concept_tags || [];

  const lastRecalledMs = memory.last_recalled_at ? Date.parse(memory.last_recalled_at) : NaN;
  const ageDays = Number.isFinite(lastRecalledMs) ? (nowMs - lastRecalledMs) / DAY_MS : Infinity;

  const components = {
    // Mean similarity across counted recalls.
    relevance: recallCount > 0 ? clamp01(memory.total_score / recallCount) : 0,
    // Saturating: 10 recalls ≈ 1.0, so a memory cannot win on volume alone.
    frequency: clamp01(Math.log1p(recallCount) / Math.log1p(10)),
    diversity: clamp01(Math.max(queries.size, days.length) / 5),
    recency: clamp01(Math.exp((-Math.LN2 / RECENCY_HALF_LIFE_DAYS) * ageDays)),
    consolidation: consolidationComponent(days),
    // Existing rows predate concept tagging and score 0 here — costs them at
    // most 0.06. New memories are tagged at write time (vectorStore.embedAndStore).
    conceptual: clamp01(conceptTags.length / 6),
  };

  const score = Object.entries(PROMOTION_WEIGHTS)
    .reduce((sum, [name, weight]) => sum + weight * components[name], 0);

  const blockedBy = [];
  if (recallCount < PROMOTION_GATES.minRecallCount) blockedBy.push('recall_count');
  if (queries.size < PROMOTION_GATES.minUniqueQueries) blockedBy.push('unique_queries');
  if (score < PROMOTION_GATES.minScore) blockedBy.push('score');
  if (ageDays > MAX_AGE_DAYS) blockedBy.push('stale');

  return { score, components, promotable: blockedBy.length === 0, blockedBy };
}

/**
 * Rank a user's candidates and return the ones to promote, best first.
 * Pure — the caller performs the write.
 */
export function selectPromotable(memories, nowMs = Date.now(), cap = MAX_PROMOTED_PER_USER) {
  return memories
    .map(m => ({ memory: m, ...scoreMemory(m, nowMs) }))
    .filter(r => r.promotable)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
}

/**
 * One sweep: score every user's candidates and promote what clears the gates.
 * Runs off the hot path (see the scheduler in index.js).
 */
export async function runPromotionSweep({ nowMs = Date.now() } = {}) {
  const candidates = await getPromotionCandidates();
  if (!candidates.length) return { users: 0, scanned: 0, promoted: 0 };

  const byUser = new Map();
  for (const memory of candidates) {
    if (!byUser.has(memory.user_id)) byUser.set(memory.user_id, []);
    byUser.get(memory.user_id).push(memory);
  }

  let promoted = 0;
  for (const [userId, memories] of byUser) {
    // Already-promoted memories still count against the cap, or a sweep would
    // keep promoting on top of a full tier every night.
    const alreadyPromoted = memories.filter(m => m.promoted).length;
    const room = MAX_PROMOTED_PER_USER - alreadyPromoted;
    if (room <= 0) continue;

    const winners = selectPromotable(memories.filter(m => !m.promoted), nowMs, room);
    if (!winners.length) continue;

    await markPromoted(winners.map(w => w.memory.id));
    promoted += winners.length;
    console.log(
      `[Promotion] ${userId}: promoted ${winners.length} ` +
      `(scores ${winners.map(w => w.score.toFixed(2)).join(', ')})`
    );
  }

  return { users: byUser.size, scanned: candidates.length, promoted };
}
