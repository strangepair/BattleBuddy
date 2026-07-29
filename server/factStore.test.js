/**
 * Pure-helper tests for the fact store: key discipline (slugs, uniqueness,
 * format) and staleness horizons. The database paths are exercised in
 * production behind graceful-absence guards; the discipline that keeps keys
 * and horizons coherent is what must not regress silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyKey, ensureUniqueKey, reviewAfterFor, shouldUpgradeConfidence,
  KEY_PATTERN, FACT_CATEGORIES, REVIEW_HORIZONS,
} from './factStore.js';

test('slugifyKey normalizes to category.kebab-slug', () => {
  assert.equal(slugifyKey('trigger', 'Morning coffee on the porch'), 'trigger.morning-coffee-on-the');
  assert.equal(slugifyKey('coping', 'Cold water!!'), 'coping.cold-water');
  assert.equal(slugifyKey('person', "Alec's Chantix situation"), 'person.alecs-chantix-situation');
});

test('slugifyKey output always satisfies KEY_PATTERN', () => {
  const inputs = ['Morning coffee', '!!!', '   ', 'a', 'x'.repeat(200), 'Ünïcödé wörds here'];
  for (const input of inputs) {
    const key = slugifyKey('trigger', input);
    assert.match(key, KEY_PATTERN, `'${input}' → '${key}' must match KEY_PATTERN`);
  }
});

test('near-identical statements normalize to the same key — that is the point', () => {
  assert.equal(
    slugifyKey('trigger', 'morning coffee'),
    slugifyKey('trigger', 'Morning Coffee'),
  );
});

test('ensureUniqueKey suffixes on collision and leaves free keys alone', () => {
  const existing = new Set(['trigger.morning-coffee', 'trigger.morning-coffee-2']);
  assert.equal(ensureUniqueKey(existing, 'trigger.morning-coffee'), 'trigger.morning-coffee-3');
  assert.equal(ensureUniqueKey(existing, 'trigger.evening-beer'), 'trigger.evening-beer');
});

test('every category has an explicit horizon entry (null = durable is a decision, not an omission)', () => {
  for (const category of FACT_CATEGORIES) {
    assert.ok(category in REVIEW_HORIZONS.categories, `missing horizon decision for '${category}'`);
  }
});

test('reviewAfterFor: durable categories return null; volatile ones return a future instant', () => {
  const now = Date.parse('2026-07-28T00:00:00Z');
  assert.equal(reviewAfterFor('motivation', 'motivation.kids', now), null);
  assert.equal(reviewAfterFor('person', 'person.alec', now), null);

  const trigger = reviewAfterFor('trigger', 'trigger.morning-coffee', now);
  assert.equal(trigger, new Date(now + 60 * 24 * 3600 * 1000).toISOString());

  // Key-level overrides beat the category default
  const usage = reviewAfterFor('quit', 'quit.usage', now);
  assert.equal(usage, new Date(now + 14 * 24 * 3600 * 1000).toISOString());
  assert.equal(reviewAfterFor('quit', 'quit.reason', now), null, 'quit.reason is durable');
});

test('confidence upgrades only on a second INDEPENDENT sighting', () => {
  const tentative = {
    confidence: 'tentative',
    evidence: [{ session_id: 's1', date: '2026-07-01' }],
  };
  assert.equal(shouldUpgradeConfidence(tentative, { session_id: 's2' }), true, 'different session upgrades');
  assert.equal(shouldUpgradeConfidence(tentative, { session_id: 's1' }), false, 'same session is not independent');
  assert.equal(shouldUpgradeConfidence(tentative, {}), false, 'no session id, no upgrade');
  assert.equal(
    shouldUpgradeConfidence({ confidence: 'confirmed', evidence: [{ session_id: 's1' }] }, { session_id: 's2' }),
    false,
    'confirmed never downgraded by the strengthen path'
  );
});
