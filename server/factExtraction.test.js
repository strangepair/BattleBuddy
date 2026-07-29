/**
 * Shadow-write translation tests: extraction output → gate proposals.
 * Pins the routing (what flows, what never does) and the confidence ceiling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { proposalsFromExtraction } from './factExtraction.js';

test('fact-like extraction fields become source=extraction proposals', () => {
  const proposals = proposalsFromExtraction({
    daily_usage: '3/day, down from 8',
    triggers: ['finishing a work block'],
    what_works: ['cold water on the face'],
    motivations: ['wants his kids to never see him smoke'],
  });

  const categories = proposals.map(p => p.category).sort();
  assert.deepEqual(categories, ['coping', 'motivation', 'quit', 'trigger']);
  assert.ok(proposals.every(p => p.source === 'extraction'));
  const usage = proposals.find(p => p.key === 'quit.usage');
  assert.match(usage.value, /3\/day/);
});

test('ledger and episodic fields never become canonical facts', () => {
  const proposals = proposalsFromExtraction({
    activity_log: [{ time: '3:15 PM', event: 'had a cigarette', type: 'smoke' }],
    session_summary: { date: '2026-07-28', summary: 'A session happened.' },
    recent_insights: ['he realized transitions are the pattern'],
    user_quotes: ['"it feels like a rubber band"'],
    life_context: ['likes woodworking'],
    next_session_hints: ['ask about the gym'],
  });
  assert.deepEqual(proposals, [], 'none of these fields may reach the fact store');
});

test('extraction output can never mint a confirmed fact — observed is the ceiling', () => {
  const proposals = proposalsFromExtraction({
    schedule_model: {
      routine_blocks: [{ label: 'work 9-12', protects: true, confidence: 'confirmed' }],
      vulnerability_windows: [],
      life_change_watch: [],
    },
  });
  const routine = proposals.find(p => p.category === 'routine');
  assert.ok(routine);
  assert.equal(routine.confidence, 'observed', 'extraction "confirmed" caps at observed; only the user confirms');
});

test('empty or null updates produce no proposals', () => {
  assert.deepEqual(proposalsFromExtraction(null), []);
  assert.deepEqual(proposalsFromExtraction({}), []);
  assert.deepEqual(proposalsFromExtraction({ activity_log: [] }), []);
});

test('shadow writes are wired into both extraction call sites behind the flag', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');

  assert.ok(indexSource.includes("process.env.FACTS_SHADOW_WRITE === 'true'"),
    'shadow writes must be OPT-IN — off until the backfill audit lands');
  const calls = indexSource.match(/maybeShadowWriteFacts\(/g) || [];
  assert.ok(calls.length >= 3, 'expected the definition plus both call sites (/session/turn throttle and /context/analyze)');
  // Still no prompt-path reads in Phase 1 (the Phase 0 invariant holds).
  assert.ok(!/buildSystemPrompt\([\s\S]{0,400}renderMemoryDoc/.test(indexSource),
    'renderMemoryDoc must not feed buildSystemPrompt until the Phase 2 flag ships');
});
