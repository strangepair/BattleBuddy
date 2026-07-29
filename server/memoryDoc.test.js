/**
 * Renderer tests — the memory document is what the agent reads AND what the
 * user audits, so its properties are load-bearing: deterministic output,
 * hedged tentatives, one reconfirm nudge max, importance-ordered trimming
 * (never oldest-first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMemoryDoc, selectFactsForBudget, isStale, DEFAULT_DOC_BUDGET } from './memoryDoc.js';

const NOW = Date.parse('2026-07-28T12:00:00Z');
const PAST = '2026-07-01T00:00:00Z';   // stale horizon
const FUTURE = '2026-09-01T00:00:00Z'; // fresh horizon

let seq = 0;
function fact(overrides = {}) {
  seq++;
  return {
    id: `id-${seq}`,
    category: 'trigger',
    key: `trigger.fact-${seq}`,
    value: `Fact number ${seq}`,
    detail: null,
    status: 'active',
    confidence: 'observed',
    source: 'extraction',
    evidence: [{ session_id: 's1', date: '2026-07-01' }],
    conflict_with: null,
    review_after: FUTURE,
    ...overrides,
  };
}

test('empty fact list renders the honest empty state, not an invented profile', () => {
  const doc = renderMemoryDoc([], { nowMs: NOW });
  assert.match(doc, /no confirmed facts yet/i);
  assert.match(doc, /never invent/i);
});

test('sections render in spec order and only when populated', () => {
  const doc = renderMemoryDoc([
    fact({ category: 'identity', key: 'identity.name', value: 'Their name is Mike.', review_after: null }),
    fact({ category: 'motivation', key: 'motivation.kids', value: 'Wants to be around for his kids.', review_after: null }),
    fact({ category: 'coping', key: 'coping.cold-water', value: 'Cold water on the face.', detail: { effectiveness: 'working', resist_count: 6 } }),
    fact({ category: 'preference', key: 'preference.response-style', value: 'Prefers brief responses.', review_after: null }),
  ], { name: 'Mike', nowMs: NOW });

  const idx = s => doc.indexOf(s);
  assert.ok(idx('## What you know about Mike') !== -1);
  assert.ok(idx("## Why they're quitting") > idx('## What you know about Mike'));
  assert.ok(idx("## What works and what doesn't") > idx("## Why they're quitting"));
  assert.ok(idx('## How they want you to be') > idx("## What works and what doesn't"));
  // Unpopulated sections are absent entirely
  assert.equal(idx('## Their people'), -1);
  assert.equal(idx('## Watch for'), -1);
});

test('tentative facts render hedged; confirmed facts render plain and first', () => {
  const doc = renderMemoryDoc([
    fact({ category: 'trigger', key: 'trigger.b-tentative', value: 'Maybe boredom.', confidence: 'tentative' }),
    fact({ category: 'trigger', key: 'trigger.a-confirmed', value: 'Morning coffee.', confidence: 'confirmed' }),
  ], { nowMs: NOW });
  assert.match(doc, /- mentioned once: Maybe boredom\./);
  assert.match(doc, /- Morning coffee\./);
  assert.ok(doc.indexOf('Morning coffee') < doc.indexOf('Maybe boredom'), 'confirmed renders before tentative');
});

test('coping effectiveness annotations: failed strategies carry the do-not-re-suggest marker', () => {
  const doc = renderMemoryDoc([
    fact({ category: 'coping', key: 'coping.gym', value: 'Going to the gym.', detail: { effectiveness: 'failed' } }),
    fact({ category: 'coping', key: 'coping.walk', value: 'A short walk.', detail: { effectiveness: 'working', resist_count: 3 } }),
  ], { nowMs: NOW });
  assert.match(doc, /has NOT worked for them — do not re-suggest/);
  assert.match(doc, /working — 3 resists/);
});

test('exactly one reconfirm nudge per render, on the most overdue stale fact', () => {
  const doc = renderMemoryDoc([
    fact({ key: 'trigger.older-stale', value: 'Oldest stale.', review_after: '2026-06-01T00:00:00Z' }),
    fact({ key: 'trigger.newer-stale', value: 'Newer stale.', review_after: PAST }),
    fact({ key: 'trigger.fresh', value: 'Fresh fact.', review_after: FUTURE }),
  ], { nowMs: NOW });

  const nudges = doc.match(/reconfirm naturally/g) || [];
  assert.equal(nudges.length, 1, 'at most one reconfirm call-to-action');
  assert.match(doc, /Oldest stale\..*reconfirm naturally/, 'most overdue fact carries the nudge');
  assert.match(doc, /Newer stale\..*may be stale/, 'other stale facts are marked but not nudged');
  assert.ok(!/Fresh fact\..*stale/.test(doc), 'fresh facts carry no stale mark');
});

test('durable facts (null review_after) never go stale', () => {
  assert.equal(isStale({ review_after: null }, NOW), false);
  assert.equal(isStale({ review_after: PAST }, NOW), true);
});

test('conflict pairs are flagged for natural clarification', () => {
  const doc = renderMemoryDoc([
    fact({ category: 'coping', key: 'coping.gym', value: 'The gym helps.', conflict_with: 'other-id' }),
  ], { nowMs: NOW });
  assert.match(doc, /conflicting notes on this — clarify naturally/);
});

test('budget trim drops tentative first, then stale, and never the durable confirmed motivation', () => {
  const motivation = fact({
    category: 'motivation', key: 'motivation.founding', confidence: 'confirmed',
    value: 'Founding motivation from week one.', review_after: null,
    evidence: [{ session_id: 's1' }],
  });
  const confirmedFresh = fact({ confidence: 'confirmed', value: 'Confirmed fresh fact.', evidence: [{ session_id: 's1' }, { session_id: 's2' }] });
  const staleObserved = fact({ value: 'Stale observed fact.', review_after: PAST, evidence: [{ session_id: 's1' }] });
  const tentatives = Array.from({ length: 30 }, (_, i) =>
    fact({ confidence: 'tentative', value: `Tentative filler ${i} ${'x'.repeat(80)}` }));

  const all = [motivation, confirmedFresh, staleObserved, ...tentatives];
  const render = kept => renderMemoryDoc(kept, { nowMs: NOW, budget: Infinity });
  const kept = selectFactsForBudget(all, 1200, NOW, render);

  assert.ok(kept.includes(motivation), 'durable confirmed motivation survives');
  assert.ok(kept.includes(confirmedFresh), 'confirmed fresh fact survives');
  const keptTentative = kept.filter(f => f.confidence === 'tentative').length;
  assert.ok(keptTentative < 30, 'tentatives were dropped');
  // Stale observed only drops after ALL tentatives are gone
  if (!kept.includes(staleObserved)) {
    assert.equal(keptTentative, 0, 'stale tier must not be touched while tentatives remain');
  }
});

test('renderer is deterministic — identical input, byte-identical output (one renderer, two consumers)', () => {
  const facts = [
    fact({ category: 'identity', key: 'identity.name', value: 'Their name is Mike.', review_after: null }),
    fact({ category: 'coping', key: 'coping.walk', value: 'A short walk.', detail: { effectiveness: 'working' } }),
  ];
  const a = renderMemoryDoc(facts, { name: 'Mike', nowMs: NOW });
  const b = renderMemoryDoc(facts, { name: 'Mike', nowMs: NOW });
  assert.equal(a, b);
});

test('open commitments render alongside; delivered ones do not', () => {
  const doc = renderMemoryDoc([fact()], {
    nowMs: NOW,
    commitments: [
      { summary: 'Said they would try the gym Tuesday.', status: 'pending' },
      { summary: 'Old delivered follow-up.', status: 'delivered' },
    ],
  });
  assert.match(doc, /## Open follow-ups/);
  assert.match(doc, /gym Tuesday/);
  assert.ok(!doc.includes('Old delivered follow-up'));
});

test('default budget matches the profile blob cap it replaces', () => {
  assert.equal(DEFAULT_DOC_BUDGET, 12000);
});
