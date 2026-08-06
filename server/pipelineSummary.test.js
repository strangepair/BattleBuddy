import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, digestLine, changeKey } from './pipelineSummary.js';

const NOW = Date.parse('2026-08-06T03:30:00.000Z');

let seq = 0;
function row(over) {
  seq += 1;
  return {
    id: over.id ?? `id-${seq}`,
    title: over.title ?? `change ${seq}`,
    archived: false,
    created_at: '2026-08-06T02:00:00.000Z',
    ...over,
  };
}

test('an idle pipeline reports zero, not the size of the page it read', () => {
  // The regression this replaces: the old digest counted the newest 20 rows of
  // work_items whatever their stage, so it said "20 in flight" against exactly
  // this input.
  const rows = Array.from({ length: 48 }, (_, i) =>
    row({ status: 'deployed', pr_number: 100 + i }));
  const s = summarize(rows, NOW);
  assert.equal(s.inFlight, 0);
  assert.equal(s.moving, 0);
  assert.equal(s.attention, 0);
  assert.equal(s.terminal, 48);
  assert.match(digestLine(s, NOW), /^Pipeline clear — nothing in flight/);
});

test('counts split moving work from work that is stuck', () => {
  const s = summarize([
    row({ status: 'building', pr_number: 1 }),
    row({ status: 'deploying', pr_number: 2 }),
    row({ status: 'needs_attention', pr_number: 3 }),
    row({ status: 'failed', pr_number: 4 }),
    row({ status: 'deployed', pr_number: 5 }),
  ], NOW);
  assert.equal(s.inFlight, 4);
  assert.equal(s.moving, 2);
  assert.equal(s.attention, 2);
  assert.equal(s.terminal, 1);
  assert.equal(digestLine(s, NOW).startsWith('4 changes in flight — (1 building, 1 deploying, 2 needing attention)'), true);
});

test('archived rows are ignored even when the caller forgets to filter', () => {
  const s = summarize([
    row({ status: 'pending', archived: true }),
    row({ status: 'deployed', archived: true }),
    row({ status: 'building', pr_number: 9 }),
  ], NOW);
  assert.equal(s.inFlight, 1);
  assert.equal(s.terminal, 0);
});

test('one change owning several rows counts once', () => {
  const s = summarize([
    row({ id: 'a', status: 'deployed', pr_number: 126, work_item_id: 'wi-1' }),
    row({ id: 'b', status: 'deployed', pr_number: 126 }),
    row({ id: 'c', status: 'superseded', pr_number: 126 }),
  ], NOW);
  assert.equal(s.changes, 1);
  assert.equal(s.terminal, 1);
  assert.equal(s.byStatus.deployed, 1);
  assert.equal(s.byStatus.superseded, undefined);
});

test('live work speaks for a change that also has a dead row', () => {
  const s = summarize([
    row({ id: 'dead', status: 'superseded', work_item_id: 'wi-2' }),
    row({ id: 'live', status: 'building', work_item_id: 'wi-2' }),
  ], NOW);
  assert.equal(s.inFlight, 1);
  assert.equal(s.terminal, 0);
  assert.equal(s.inFlightItems[0].id, 'live');
});

test('the digest names the last thing that shipped', () => {
  const s = summarize([
    row({ status: 'deployed', pr_number: 138, updated_at: '2026-08-06T02:37:00.000Z' }),
    row({ status: 'deployed', pr_number: 130, updated_at: '2026-08-05T18:40:00.000Z' }),
  ], NOW);
  assert.equal(s.lastShipped.pr_number, 138);
  assert.match(digestLine(s, NOW), /last shipped PR #138 53m ago/);
});

test('an empty pipeline is clear, and says so without a shipped clause', () => {
  const s = summarize([], NOW);
  assert.equal(s.inFlight, 0);
  assert.equal(digestLine(s, NOW), 'Pipeline clear — nothing in flight');
});

test('in-flight items are capped so the response cannot grow without bound', () => {
  const rows = Array.from({ length: 40 }, (_, i) => row({ status: 'pending', pr_number: 500 + i }));
  const s = summarize(rows, NOW);
  assert.equal(s.inFlight, 40);
  assert.equal(s.inFlightItems.length, 25);
});

test('a change is keyed by PR, then work item, then branch, then row id', () => {
  assert.equal(changeKey({ pr_number: 7, work_item_id: 'w' }), 'pr:7');
  assert.equal(changeKey({ work_item_id: 'w', branch: 'b' }), 'wi:w');
  assert.equal(changeKey({ branch: 'b' }), 'br:b');
  assert.equal(changeKey({ id: 'z' }), 'id:z');
});

test('malformed rows do not throw or inflate the counts', () => {
  const s = summarize([null, undefined, {}, row({ status: 'building', pr_number: 1 })], NOW);
  assert.equal(s.inFlight, 1);
});
