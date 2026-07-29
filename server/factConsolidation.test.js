/**
 * Consolidation sweep tests — the pure selection halves. The sweep itself is
 * report-only in Phase 1; what must not regress is which facts it flags.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, findNearDuplicates, sweepUser, NEAR_DUP_THRESHOLD } from './factConsolidation.js';

const NOW = Date.parse('2026-07-28T12:00:00Z');

test('cosine similarity basics', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], [1]), 0, 'mismatched/empty vectors score 0, never throw');
});

test('near-duplicate scan pairs same-category facts above the threshold only', () => {
  const embedded = [
    { fact: { key: 'trigger.morning-coffee', category: 'trigger' }, vector: [1, 0, 0] },
    { fact: { key: 'trigger.coffee-first-thing', category: 'trigger' }, vector: [0.99, 0.1, 0] },
    { fact: { key: 'trigger.driving-home', category: 'trigger' }, vector: [0, 1, 0] },
    { fact: { key: 'coping.coffee-substitute', category: 'coping' }, vector: [1, 0, 0] },
  ];
  const pairs = findNearDuplicates(embedded);
  assert.equal(pairs.length, 1, 'only the two coffee triggers pair up');
  assert.deepEqual([pairs[0].a, pairs[0].b], ['trigger.morning-coffee', 'trigger.coffee-first-thing']);
  assert.ok(pairs[0].similarity >= NEAR_DUP_THRESHOLD);
  // Cross-category identical vectors do NOT pair — vectors are a maintenance
  // index within a category, not a truth oracle across them.
});

test('sweepUser flags stale and conflicted facts, leaves fresh durable ones alone', () => {
  const { stale, conflicts } = sweepUser([
    { key: 'quit.usage', value: '8/day', review_after: '2026-07-01T00:00:00Z', confidence: 'observed', conflict_with: null },
    { key: 'motivation.kids', value: 'his kids', review_after: null, confidence: 'confirmed', conflict_with: null },
    { key: 'coping.gym', value: 'gym helps', review_after: '2026-09-01T00:00:00Z', confidence: 'observed', conflict_with: 'other-id' },
  ], NOW);

  assert.equal(stale.length, 1);
  assert.equal(stale[0].key, 'quit.usage');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'coping.gym');
});
