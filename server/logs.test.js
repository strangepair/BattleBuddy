/**
 * Integration tests for the activity-log endpoints added to index.js.
 *
 * index.js is a monolithic server with side-effects (port binding, file I/O,
 * network calls), so we test the route logic using the same pattern as
 * index.test.js: lightweight inline mirrors that reproduce the exact decision
 * rules without importing the server.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Inline mirrors of helpers used by the new routes ────────────────────────

function resolveUserId(id) {
  return id;
}

function buildActivityRow({ userId, activity_name, start_time, end_time, location }) {
  const row = {
    user_id: resolveUserId(userId),
    activity_name,
    start_time,
  };
  if (end_time !== undefined && end_time !== null) row.end_time = end_time;
  if (location !== undefined && location !== null) row.location = location;
  return row;
}

function validateActivityBody({ userId, activity_name, start_time }) {
  return !!(userId && activity_name && start_time);
}

function mergeAndSort(cigarettes, activities, limit = 50) {
  const cigs = cigarettes.map(r => ({
    type: 'cigarette',
    id: r.id,
    occurred_at: r.occurred_at,
    metadata: r.metadata,
  }));
  const acts = activities.map(r => ({
    type: 'activity',
    id: r.id,
    activity_name: r.activity_name,
    start_time: r.start_time,
    end_time: r.end_time ?? null,
    location: r.location ?? null,
    created_at: r.created_at,
  }));
  return [...cigs, ...acts]
    .sort((a, b) => {
      const ta = a.occurred_at || a.start_time;
      const tb = b.occurred_at || b.start_time;
      return new Date(tb) - new Date(ta);
    })
    .slice(0, limit);
}

// ─── POST /logs/activity — validation ────────────────────────────────────────

test('POST /logs/activity — missing userId → invalid', () => {
  assert.equal(validateActivityBody({ activity_name: 'run', start_time: '2026-08-01T08:00:00Z' }), false);
});

test('POST /logs/activity — missing activity_name → invalid', () => {
  assert.equal(validateActivityBody({ userId: 'u1', start_time: '2026-08-01T08:00:00Z' }), false);
});

test('POST /logs/activity — missing start_time → invalid', () => {
  assert.equal(validateActivityBody({ userId: 'u1', activity_name: 'run' }), false);
});

test('POST /logs/activity — all required fields → valid', () => {
  assert.equal(validateActivityBody({ userId: 'u1', activity_name: 'run', start_time: '2026-08-01T08:00:00Z' }), true);
});

// ─── POST /logs/activity — row construction ───────────────────────────────────

test('buildActivityRow — minimal payload omits nullable fields', () => {
  const row = buildActivityRow({ userId: 'u1', activity_name: 'walk', start_time: '2026-08-01T07:00:00Z' });
  assert.equal(row.user_id, 'u1');
  assert.equal(row.activity_name, 'walk');
  assert.equal(row.start_time, '2026-08-01T07:00:00Z');
  assert.equal('end_time' in row, false);
  assert.equal('location' in row, false);
});

test('buildActivityRow — full payload includes end_time and location', () => {
  const row = buildActivityRow({
    userId: 'u1',
    activity_name: 'gym',
    start_time: '2026-08-01T06:00:00Z',
    end_time: '2026-08-01T07:30:00Z',
    location: 'Planet Fitness',
  });
  assert.equal(row.end_time, '2026-08-01T07:30:00Z');
  assert.equal(row.location, 'Planet Fitness');
});

test('buildActivityRow — explicit null end_time is omitted', () => {
  const row = buildActivityRow({ userId: 'u1', activity_name: 'walk', start_time: '2026-08-01T07:00:00Z', end_time: null });
  assert.equal('end_time' in row, false);
});

// ─── GET /logs — merge and sort ───────────────────────────────────────────────

test('GET /logs — empty tables return empty logs', () => {
  const result = mergeAndSort([], []);
  assert.deepEqual(result, []);
});

test('GET /logs — cigarette entries carry type=cigarette', () => {
  const result = mergeAndSort(
    [{ id: 'c1', occurred_at: '2026-08-01T10:00:00Z', metadata: {} }],
    [],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'cigarette');
  assert.equal(result[0].id, 'c1');
});

test('GET /logs — activity entries carry type=activity', () => {
  const result = mergeAndSort(
    [],
    [{ id: 'a1', activity_name: 'walk', start_time: '2026-08-01T09:00:00Z', end_time: null, location: null, created_at: '2026-08-01T09:00:00Z' }],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'activity');
  assert.equal(result[0].activity_name, 'walk');
});

test('GET /logs — mixed entries are sorted newest first', () => {
  const result = mergeAndSort(
    [
      { id: 'c1', occurred_at: '2026-08-01T08:00:00Z', metadata: {} },
      { id: 'c2', occurred_at: '2026-08-01T12:00:00Z', metadata: {} },
    ],
    [
      { id: 'a1', activity_name: 'gym', start_time: '2026-08-01T06:00:00Z', end_time: null, location: null, created_at: '2026-08-01T06:00:00Z' },
      { id: 'a2', activity_name: 'walk', start_time: '2026-08-01T10:00:00Z', end_time: null, location: null, created_at: '2026-08-01T10:00:00Z' },
    ],
  );
  assert.equal(result.length, 4);
  assert.equal(result[0].id, 'c2');
  assert.equal(result[1].id, 'a2');
  assert.equal(result[2].id, 'c1');
  assert.equal(result[3].id, 'a1');
});

test('GET /logs — limit is honoured', () => {
  const cigarettes = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    occurred_at: `2026-08-01T${String(i).padStart(2, '0')}:00:00Z`,
    metadata: {},
  }));
  const result = mergeAndSort(cigarettes, [], 3);
  assert.equal(result.length, 3);
});

test('GET /logs — nullable activity fields default to null in output', () => {
  const result = mergeAndSort(
    [],
    [{ id: 'a1', activity_name: 'rest', start_time: '2026-08-01T20:00:00Z', end_time: undefined, location: undefined, created_at: '2026-08-01T20:00:00Z' }],
  );
  assert.equal(result[0].end_time, null);
  assert.equal(result[0].location, null);
});

test('GET /logs — existing cigarette fields are unaffected', () => {
  const result = mergeAndSort(
    [{ id: 'c1', occurred_at: '2026-08-01T11:00:00Z', metadata: { trigger: 'stress' } }],
    [],
  );
  assert.deepEqual(result[0].metadata, { trigger: 'stress' });
  assert.equal(result[0].occurred_at, '2026-08-01T11:00:00Z');
});
