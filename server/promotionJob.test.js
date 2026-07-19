/**
 * Scoring is pure, so this exercises the real math with no database.
 *
 * The case that matters most is the last one: five recalls in one afternoon
 * must not look like five recalls across five days. Both have recall_count = 5.
 * If that distinction breaks, a single bad night promotes itself into the
 * user's permanent context and stays there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreMemory,
  selectPromotable,
  consolidationComponent,
  parseRecallKeys,
  PROMOTION_WEIGHTS,
  PROMOTION_GATES,
} from './promotionJob.js';
import { deriveConceptTags } from './conceptTags.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-19T12:00:00Z');

/** A memory recalled once per day across `days` consecutive days. */
function spreadOverDays(days, { similarity = 0.8, tags = 6, hashes = days } = {}) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(NOW - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    keys.push(`${day}:${String(i % hashes).padStart(12, 'q')}`);
  }
  return {
    id: `mem-${days}`,
    user_id: 'user-1',
    recall_count: days,
    total_score: similarity * days,
    recall_keys: keys,
    concept_tags: Array.from({ length: tags }, (_, i) => `tag${i}`),
    last_recalled_at: new Date(NOW).toISOString(),
    promoted: false,
  };
}

test('weights sum to 1.0', () => {
  const total = Object.values(PROMOTION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test('parseRecallKeys splits days from query hashes', () => {
  const { days, queries } = parseRecallKeys([
    '2026-07-01:aaaaaaaaaaaa',
    '2026-07-01:bbbbbbbbbbbb',
    '2026-07-02:aaaaaaaaaaaa',
  ]);
  assert.deepEqual(days, ['2026-07-01', '2026-07-02']);
  assert.equal(queries.size, 2);
});

test('parseRecallKeys ignores malformed entries', () => {
  const { days, queries } = parseRecallKeys(['garbage', '', null, undefined, '2026-07-01:abcdefghijkl']);
  assert.deepEqual(days, ['2026-07-01']);
  assert.equal(queries.size, 1);
});

test('score stays within [0,1] at both extremes', () => {
  const empty = scoreMemory({ recall_count: 0, total_score: 0, recall_keys: [], concept_tags: [] }, NOW);
  assert.ok(empty.score >= 0 && empty.score <= 1, `empty scored ${empty.score}`);

  const saturated = scoreMemory(spreadOverDays(30, { similarity: 1, tags: 20 }), NOW);
  assert.ok(saturated.score >= 0 && saturated.score <= 1, `saturated scored ${saturated.score}`);
});

test('gates block a memory that scores well but lacks evidence', () => {
  // One recall, perfect similarity — the score component is strong, but a
  // single recall is not evidence of anything durable.
  const oneStrongHit = {
    recall_count: 1,
    total_score: 1,
    recall_keys: [`${new Date(NOW).toISOString().slice(0, 10)}:aaaaaaaaaaaa`],
    concept_tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    last_recalled_at: new Date(NOW).toISOString(),
  };
  const result = scoreMemory(oneStrongHit, NOW);
  assert.equal(result.promotable, false);
  assert.ok(result.blockedBy.includes('recall_count'));
  assert.ok(result.blockedBy.includes('unique_queries'));
});

test('a stale memory is blocked however strong its history', () => {
  const stale = spreadOverDays(10);
  stale.last_recalled_at = new Date(NOW - 60 * DAY).toISOString();
  const result = scoreMemory(stale, NOW);
  assert.equal(result.promotable, false);
  assert.ok(result.blockedBy.includes('stale'));
});

test('frequency saturates so volume alone cannot promote', () => {
  const ten = scoreMemory(spreadOverDays(10), NOW).components.frequency;
  const fifty = scoreMemory(spreadOverDays(50), NOW).components.frequency;
  assert.ok(ten > 0.95, `10 recalls should be near-saturated, got ${ten}`);
  assert.ok(fifty - ten < 0.05, 'past ~10 recalls, more volume should barely move the needle');
});

test('consolidation separates spread-out recall from a single burst', () => {
  const oneDay = consolidationComponent(['2026-07-19']);
  const spread = consolidationComponent(['2026-07-13', '2026-07-15', '2026-07-17', '2026-07-19']);
  assert.ok(spread > oneDay * 2, `spread ${spread} should clearly beat single-day ${oneDay}`);
});

test('five recalls in one afternoon do not promote; five across five days do', () => {
  const today = new Date(NOW).toISOString().slice(0, 10);

  // Same day, five genuinely different queries — passes the query-diversity
  // gate, so consolidation is the only thing standing between one bad night and
  // a permanent memory.
  const burst = {
    id: 'burst',
    user_id: 'user-1',
    recall_count: 5,
    total_score: 0.8 * 5,
    recall_keys: [0, 1, 2, 3, 4].map(i => `${today}:${String(i).padStart(12, 'q')}`),
    concept_tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    last_recalled_at: new Date(NOW).toISOString(),
    promoted: false,
  };
  const spread = spreadOverDays(5);

  const burstResult = scoreMemory(burst, NOW);
  const spreadResult = scoreMemory(spread, NOW);

  assert.ok(
    spreadResult.score > burstResult.score,
    `spread (${spreadResult.score.toFixed(3)}) should outscore burst (${burstResult.score.toFixed(3)})`
  );
  assert.equal(burstResult.promotable, false, 'a single afternoon should not promote');
  assert.ok(burstResult.blockedBy.includes('score'));
  assert.equal(spreadResult.promotable, true, 'recurrence across days should promote');
});

test('selectPromotable ranks best first and respects the cap', () => {
  const memories = [spreadOverDays(5), spreadOverDays(8), spreadOverDays(12)];
  const picked = selectPromotable(memories, NOW, 2);

  assert.equal(picked.length, 2);
  assert.ok(picked[0].score >= picked[1].score, 'results should be ordered best first');
});

test('selectPromotable returns nothing when no candidate clears the gates', () => {
  assert.deepEqual(selectPromotable([spreadOverDays(1)], NOW), []);
});

test('gate constants match the documented thresholds', () => {
  // Guards against a quiet edit loosening promotion — these thresholds are the
  // reason a memory has to earn its place.
  assert.deepEqual(PROMOTION_GATES, { minScore: 0.8, minRecallCount: 3, minUniqueQueries: 3 });
});

test('deriveConceptTags drops stopwords and dedupes', () => {
  const tags = deriveConceptTags('The parking lot after work is when the craving hits, parking lot again');
  assert.ok(tags.includes('parking'));
  assert.ok(tags.includes('craving'));
  assert.ok(!tags.includes('that'), 'stopwords should be dropped');
  assert.equal(new Set(tags).size, tags.length, 'tags should be distinct');
  assert.ok(tags.length <= 8);
});

test('deriveConceptTags handles empty and junk input', () => {
  assert.deepEqual(deriveConceptTags(''), []);
  assert.deepEqual(deriveConceptTags(null), []);
  assert.deepEqual(deriveConceptTags('a b c 123 !!'), []);
});
