/**
 * Backfill mapping tests — the deterministic profile→facts translation is the
 * first thing Mike audits (Phase 0 exit), so the mapping rules themselves are
 * pinned here: field routing, the one-row coping verdict, voice_preference
 * exclusion, and the Sonnet pass's grounding requirement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFactsFromProfile, groundSonnetProposals } from './factBackfill.js';

const FIXTURE_PROFILE = {
  name: 'Mike',
  age: 38,
  occupation: 'founder',
  occupation_updated_at: '2026-07-01T00:00:00Z',
  addiction_type: 'cigarettes',
  daily_usage: '8/day',
  quit_reason: 'wants to be around for his kids',
  longest_quit: '6 months',
  voice_preference: 'aura-2-arcas-en',
  triggers: [
    { value: 'morning coffee', captured_at: '2026-06-20T10:00:00Z' },
    { value: 'driving home', captured_at: '2026-06-25T10:00:00Z' },
  ],
  coping_strategies: [{ value: 'cold water', captured_at: '2026-06-20T10:00:00Z' }],
  what_works: [{ value: 'cold water', captured_at: '2026-06-22T10:00:00Z' }],
  what_doesnt_work: [{ value: 'going to the gym', captured_at: '2026-07-10T10:00:00Z' }],
  motivations: [{ value: 'freedom from the pack', captured_at: '2026-06-20T10:00:00Z' }],
  unknowns: [{ value: 'the rule of three', captured_at: '2026-06-24T10:00:00Z' }],
  preferred_coping_style: 'distraction',
  response_preference: 'brief',
  risk_windows: [
    { hour: 17, day_of_week: null, weight: 0.8, source: 'patch comes off', captured_at: '2026-06-26T10:00:00Z' },
  ],
  life_architecture: {
    trigger_taxonomy: [
      { trigger: 'morning coffee', context: 'porch', intensity: 7, verified: true },
    ],
    resistance_strategies: [{ value: 'going to the gym', captured_at: '2026-06-21T10:00:00Z' }],
    flow_state_activities: [],
    physical_risk_spaces: [],
    oral_habit_pairs: [],
    transition_patterns: [],
    social_contexts: [],
  },
  schedule_model: {
    routine_blocks: [{ label: 'work 9-12', protects: true, confidence: 'confirmed' }],
    vulnerability_windows: [
      { time: '17:00', day_pattern: 'weekdays', reason: 'patch comes off, resistance drops', confidence: 'confirmed' },
    ],
    life_change_watch: [{ note: 'started new job', confidence: 'confirmed' }],
  },
};

test('scalars route to identity.* and quit.* with evidence', () => {
  const facts = deriveFactsFromProfile(FIXTURE_PROFILE);
  const byKey = Object.fromEntries(facts.map(f => [f.key, f]));

  assert.match(byKey['identity.name'].value, /Mike/);
  assert.match(byKey['identity.occupation'].value, /founder/);
  assert.equal(byKey['identity.occupation'].evidence[0].date, '2026-07-01');
  assert.match(byKey['quit.usage'].value, /8\/day/);
  assert.match(byKey['quit.reason'].value, /around for his kids/);
  assert.match(byKey['quit.longest-quit'].value, /6 months/);
});

test('voice_preference is app state, never a memory fact', () => {
  const facts = deriveFactsFromProfile(FIXTURE_PROFILE);
  assert.ok(!facts.some(f => JSON.stringify(f).includes('aura-2-arcas')), 'voice preference must not be derived');
});

test('triggers and taxonomy merge on the same key instead of minting rivals', () => {
  const facts = deriveFactsFromProfile(FIXTURE_PROFILE);
  const coffee = facts.filter(f => f.key.startsWith('trigger.morning-coffee'));
  assert.equal(coffee.length, 1, 'flat trigger + taxonomy entry for the same trigger → one proposal');
  assert.equal(coffee[0].detail.intensity, 7, 'taxonomy detail enriches the merged fact');
  assert.ok(coffee[0].evidence.length >= 2, 'both sources kept as evidence');
});

test('coping verdict lives on one row: what_doesnt_work overrides an earlier working entry by recency', () => {
  const facts = deriveFactsFromProfile(FIXTURE_PROFILE);
  const gym = facts.filter(f => f.key.startsWith('coping.going-to-the-gym'));
  assert.equal(gym.length, 1, 'one row holds the whole gym verdict');
  assert.equal(gym[0].detail.effectiveness, 'failed', 'newest capture (2026-07-10, failed) wins');

  const coldWater = facts.find(f => f.key.startsWith('coping.cold-water'));
  assert.equal(coldWater.detail.effectiveness, 'working', 'what_works upgrades untested → working');
});

test('risk windows derive keyed by hour with vulnerability-window enrichment', () => {
  const facts = deriveFactsFromProfile(FIXTURE_PROFILE);
  const window = facts.find(f => f.key === 'window.17h');
  assert.ok(window, 'window.17h derived');
  assert.equal(window.detail.hour, 17);
  assert.equal(window.detail.reason, 'patch comes off, resistance drops');
  assert.equal(window.confidence, 'observed', 'confirmed vulnerability window → observed');
});

test('unknowns become watch.* open threads; routine and life-change route correctly', () => {
  const facts = deriveFactsFromProfile(FIXTURE_PROFILE);
  assert.ok(facts.some(f => f.category === 'watch' && /rule of three/.test(f.value)));
  const routine = facts.find(f => f.category === 'routine');
  assert.match(routine.value, /work 9-12/);
  assert.equal(routine.detail.protects, true);
  assert.equal(routine.confidence, 'confirmed');
  assert.ok(facts.some(f => f.category === 'watch' && /started new job/.test(f.value)));
});

test('all derived proposals are tentative-or-better with valid categories and unique keys', () => {
  const facts = deriveFactsFromProfile(FIXTURE_PROFILE);
  const keys = facts.map(f => f.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique within one derivation');
  for (const f of facts) {
    assert.ok(['tentative', 'observed', 'confirmed'].includes(f.confidence), f.key);
    assert.ok(Array.isArray(f.evidence), f.key);
  }
});

test('empty profile derives no facts (and does not throw)', () => {
  assert.deepEqual(deriveFactsFromProfile({}), []);
});

test('groundSonnetProposals enforces the grounding-quote invariant', () => {
  const { grounded, dropped } = groundSonnetProposals([
    { category: 'person', statement: 'Alec is a friend and does NOT have a Chantix prescription.', quote: 'Alec does not have a prescription, I told you twice', date: '2026-06-24' },
    { category: 'person', statement: 'Fabricated fact with no quote.', quote: '' },
    { category: 'person', statement: 'Fabricated fact with missing quote.' },
    { category: 'not-a-category', statement: 'Bad category.', quote: 'some quote here' },
  ], new Set());

  assert.equal(grounded.length, 1, 'only the grounded, valid proposal survives');
  assert.equal(dropped, 3);
  assert.equal(grounded[0].category, 'person');
  assert.equal(grounded[0].evidence[0].quote, 'Alec does not have a prescription, I told you twice');
  assert.equal(grounded[0].confidence, 'tentative', 'backfill Sonnet output is never confirmed without review');
});
