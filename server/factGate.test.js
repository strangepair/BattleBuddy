/**
 * Merge-gate tests — all pure. These pin the invariants the LLM is never
 * trusted with: grounding before judgment, precedence (a correction the user
 * made must be structurally impossible for the extractor to overwrite), key
 * discipline, and fail-closed behavior on malformed gate output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGroundingQuote, groundProposals, buildVerdictPlan, parseGateResponse,
  buildGatePrompt, SOURCE_TIER, GROUNDING_MIN_OVERLAP, GATE_MODEL,
} from './factGate.js';

const MESSAGES = [
  { role: 'assistant', content: 'How did the morning go?' },
  { role: 'user', content: 'Rough one — I always want a cigarette with my morning coffee on the porch.' },
  { role: 'user', content: 'Down to three a day now though.' },
];

function proposal(overrides = {}) {
  return {
    category: 'trigger',
    key: 'trigger.morning-coffee',
    value: 'Morning coffee on the porch triggers a cigarette urge.',
    detail: null,
    confidence: 'tentative',
    source: 'extraction',
    evidence: [],
    ...overrides,
  };
}

function activeFact(overrides = {}) {
  return {
    id: 'fact-1',
    category: 'trigger',
    key: 'trigger.morning-coffee',
    value: 'Morning coffee triggers him.',
    status: 'active',
    confidence: 'observed',
    source: 'extraction',
    evidence: [],
    ...overrides,
  };
}

// ─── Grounding ──────────────────────────────────────────────────────────────

test('a proposal grounded in what the user actually said finds its quote', () => {
  const found = findGroundingQuote('Morning coffee on the porch triggers a cigarette urge', MESSAGES);
  assert.ok(found, 'expected a grounding quote');
  assert.match(found.quote, /morning coffee on the porch/);
  assert.ok(found.overlap >= GROUNDING_MIN_OVERLAP);
});

test('a fabricated proposal with no support in the conversation is ungrounded', () => {
  const found = findGroundingQuote('His friend Alec has a Chantix prescription', MESSAGES);
  assert.equal(found, null, 'nothing in the conversation grounds this — the Alec/Chantix class of failure');
});

test('assistant messages never ground a proposal — only the user\'s words count', () => {
  const messages = [{ role: 'assistant', content: 'Morning coffee on the porch triggers a cigarette urge for you.' }];
  assert.equal(findGroundingQuote('Morning coffee on the porch triggers a cigarette urge', messages), null);
});

test('groundProposals splits grounded from ungrounded and attaches quotes', () => {
  const { grounded, ungrounded } = groundProposals([
    proposal(),
    proposal({ key: 'trigger.invented', value: 'Rainy weather makes him smoke more.' }),
    proposal({ key: 'person.alec', category: 'person', value: 'Alec does not have a prescription.', evidence: [{ quote: 'Alec does NOT have a prescription' }] }),
  ], MESSAGES);

  assert.equal(grounded.length, 2, 'quoted-already and conversation-grounded pass');
  assert.equal(ungrounded.length, 1, 'the invented one is dropped');
  assert.ok(grounded[0].evidence.some(e => e.quote), 'found quote is attached as evidence');
});

// ─── Verdict plan / precedence ──────────────────────────────────────────────

test('NEW inserts under a validated fresh key', () => {
  const p = proposal({ key: undefined });
  const plan = buildVerdictPlan([p], [{ index: 0, verdict: 'NEW', key: 'trigger.porch-coffee' }], []);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].op, 'insert');
  assert.equal(plan[0].key, 'trigger.porch-coffee');
});

test('NEW with a malformed or cross-category key falls back to a derived slug, never a freehand write', () => {
  const plan = buildVerdictPlan([proposal()], [{ index: 0, verdict: 'NEW', key: 'coping.WRONG CATEGORY!!' }], []);
  assert.equal(plan[0].op, 'insert');
  assert.match(plan[0].key, /^trigger\.[a-z0-9-]+$/);
});

test('NEW under an already-active key downgrades to strengthen — duplicates never stack', () => {
  const plan = buildVerdictPlan(
    [proposal()],
    [{ index: 0, verdict: 'NEW', key: 'trigger.morning-coffee' }],
    [activeFact()],
  );
  assert.equal(plan[0].op, 'strengthen');
  assert.equal(plan[0].key, 'trigger.morning-coffee');
});

test('DUPLICATE strengthens the referenced fact', () => {
  const plan = buildVerdictPlan(
    [proposal()],
    [{ index: 0, verdict: 'DUPLICATE', key: 'trigger.morning-coffee' }],
    [activeFact()],
  );
  assert.equal(plan[0].op, 'strengthen');
});

test('within-tier SUPERSEDES goes through — newer truth replaces old', () => {
  const plan = buildVerdictPlan(
    [proposal({ value: 'Coffee no longer triggers him since switching to tea.' })],
    [{ index: 0, verdict: 'SUPERSEDES', key: 'trigger.morning-coffee' }],
    [activeFact({ source: 'extraction', confidence: 'observed' })],
  );
  assert.equal(plan[0].op, 'supersede');
  assert.equal(plan[0].targetId, 'fact-1');
});

test('THE invariant: extraction can never auto-supersede what the user stated — it files a conflict', () => {
  const plan = buildVerdictPlan(
    [proposal({ source: 'extraction' })],
    [{ index: 0, verdict: 'SUPERSEDES', key: 'trigger.morning-coffee' }],
    [activeFact({ source: 'user_stated', confidence: 'confirmed' })],
  );
  assert.equal(plan[0].op, 'conflict', 'cross-tier downward supersede must downgrade to CONFLICTS');
});

test('extraction cannot auto-supersede a user-confirmed fact even at equal source tier', () => {
  const plan = buildVerdictPlan(
    [proposal({ source: 'extraction' })],
    [{ index: 0, verdict: 'SUPERSEDES', key: 'trigger.morning-coffee' }],
    [activeFact({ source: 'backfill', confidence: 'confirmed' })],
  );
  assert.equal(plan[0].op, 'conflict', 'a fact the user confirmed outranks the extractor regardless of source tier');
});

test('user_stated proposals CAN supersede extraction facts — corrections apply', () => {
  const plan = buildVerdictPlan(
    [proposal({ source: 'user_stated', confidence: 'confirmed' })],
    [{ index: 0, verdict: 'SUPERSEDES', key: 'trigger.morning-coffee' }],
    [activeFact({ source: 'extraction' })],
  );
  assert.equal(plan[0].op, 'supersede');
});

test('verdicts referencing unknown or cross-category keys are rejected, not guessed', () => {
  const plan = buildVerdictPlan(
    [proposal(), proposal({ category: 'coping', value: 'Cold water helps.' })],
    [
      { index: 0, verdict: 'SUPERSEDES', key: 'trigger.nonexistent' },
      { index: 1, verdict: 'DUPLICATE', key: 'trigger.morning-coffee' },
    ],
    [activeFact()],
  );
  assert.equal(plan[0].op, 'reject');
  assert.equal(plan[1].op, 'reject', 'coping proposal cannot act on a trigger fact');
});

test('fail closed: a skipped proposal or unknown verdict becomes reject, never a silent write', () => {
  const plan = buildVerdictPlan(
    [proposal(), proposal({ value: 'Another one.' })],
    [{ index: 1, verdict: 'MAYBE' }],
    [],
  );
  assert.equal(plan.length, 2);
  assert.ok(plan.every(s => s.op === 'reject'));
});

test('SOURCE_TIER encodes the spec precedence order', () => {
  assert.ok(SOURCE_TIER.user_edited > SOURCE_TIER.user_stated || SOURCE_TIER.user_edited > SOURCE_TIER.extraction);
  assert.ok(SOURCE_TIER.user_stated > SOURCE_TIER.consolidation);
  assert.ok(SOURCE_TIER.consolidation > SOURCE_TIER.extraction);
  assert.equal(SOURCE_TIER.backfill, SOURCE_TIER.extraction);
});

// ─── Gate response parsing ──────────────────────────────────────────────────

test('parseGateResponse handles clean JSON, repairable JSON, and fails closed on garbage', () => {
  assert.deepEqual(parseGateResponse('[{"index":0,"verdict":"NEW","key":"a.b"}]'), [{ index: 0, verdict: 'NEW', key: 'a.b' }]);
  assert.ok(Array.isArray(parseGateResponse('Here you go:\n[{"index": 0, "verdict": "REJECT",}]')), 'repairable output parses');
  assert.equal(parseGateResponse('I cannot produce verdicts right now.'), null, 'no JSON → null → caller fails closed');
});

test('gate prompt biases toward CONFLICTS over SUPERSEDES and forbids key reuse for NEW', () => {
  const prompt = buildGatePrompt([proposal()], [activeFact()]);
  assert.match(prompt, /choose CONFLICTS/);
  assert.match(prompt, /must not reuse an existing key/);
  assert.match(prompt, /trigger\.morning-coffee/, 'active facts are shown keyed');
});

test('gate runs on Haiku — background judgment, not the hot path model choice', () => {
  assert.equal(GATE_MODEL, 'claude-haiku-4-5-20251001');
});
