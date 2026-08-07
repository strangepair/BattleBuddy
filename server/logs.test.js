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

// normalizeOccurredAt is the REAL implementation, not a mirror — the timezone
// re-anchoring is the whole point of these tests, so mirroring it would test
// nothing.
import { normalizeOccurredAt, DEFAULT_TZ } from './timeContext.js';

// ─── Inline mirrors of helpers used by the new routes ────────────────────────

function resolveUserId(id) {
  return id;
}

/**
 * Mirrors the row construction shared by POST /logs/activity and the
 * log_activity tool handler in index.js.
 *
 * `activities`.start_time/end_time are timestamptz. An offset-less local
 * wall-clock string stored raw is read as UTC by Postgres, shifting every
 * activity by the user's whole offset (a 7:19 PM Central drive surfaced at
 * 2:19 AM). Both writers now run their times through normalizeOccurredAt,
 * the same normalization the cigarette path (bb_events.occurred_at) has had
 * since it hit the identical bug.
 */
function buildActivityRow({ userId, activity_name, start_time, end_time, location }, timezone = DEFAULT_TZ) {
  const row = {
    user_id: resolveUserId(userId),
    activity_name,
    start_time: normalizeOccurredAt(start_time, timezone),
  };
  if (end_time !== undefined && end_time !== null && end_time !== '') {
    row.end_time = normalizeOccurredAt(end_time, timezone);
  }
  if (location !== undefined && location !== null) row.location = location;
  return row;
}

// start_time is deliberately NOT required: an absent one means "right now"
// and the server stamps it, so the model never authors the current time.
function validateActivityBody({ userId, activity_name }) {
  return !!(userId && activity_name);
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

test('POST /logs/activity — missing start_time is VALID (server stamps now)', () => {
  assert.equal(validateActivityBody({ userId: 'u1', activity_name: 'run' }), true);
});

test('POST /logs/activity — all required fields → valid', () => {
  assert.equal(validateActivityBody({ userId: 'u1', activity_name: 'run', start_time: '2026-08-01T08:00:00Z' }), true);
});

// ─── POST /logs/activity — row construction ───────────────────────────────────

test('buildActivityRow — minimal payload omits nullable fields', () => {
  const row = buildActivityRow({ userId: 'u1', activity_name: 'walk', start_time: '2026-08-01T07:00:00Z' });
  assert.equal(row.user_id, 'u1');
  assert.equal(row.activity_name, 'walk');
  assert.equal(row.start_time, '2026-08-01T07:00:00.000Z');
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
  assert.equal(row.end_time, '2026-08-01T07:30:00.000Z');
  assert.equal(row.location, 'Planet Fitness');
});

test('buildActivityRow — explicit null end_time is omitted', () => {
  const row = buildActivityRow({ userId: 'u1', activity_name: 'walk', start_time: '2026-08-01T07:00:00Z', end_time: null });
  assert.equal('end_time' in row, false);
});

test('buildActivityRow — empty-string end_time is omitted, not stamped as now', () => {
  const row = buildActivityRow({ userId: 'u1', activity_name: 'walk', start_time: '2026-08-01T07:00:00Z', end_time: '' });
  assert.equal('end_time' in row, false);
});

// ─── POST /logs/activity — timezone normalization (the 2:19 AM bug) ───────────

test('buildActivityRow — offset-less local wall clock is re-anchored, not read as UTC', () => {
  // 7:19 PM Central (CDT, UTC-5) on 2026-08-05 is 00:19Z on 2026-08-06.
  // Stored raw this landed as 19:19Z and rendered 2:19 PM; written as the
  // model's 12-hour "07:19" it rendered 2:19 AM. Neither can happen now.
  const row = buildActivityRow(
    { userId: 'u1', activity_name: 'drive to park', start_time: '2026-08-05T19:19:00' },
    'America/Chicago',
  );
  assert.equal(row.start_time, '2026-08-06T00:19:00.000Z');
});

test('buildActivityRow — winter date uses the CST offset, not a hardcoded one', () => {
  // 2026-01-15 is CST (UTC-6): 19:19 local → 01:19Z the next day.
  const row = buildActivityRow(
    { userId: 'u1', activity_name: 'gym', start_time: '2026-01-15T19:19:00' },
    'America/Chicago',
  );
  assert.equal(row.start_time, '2026-01-16T01:19:00.000Z');
});

test('buildActivityRow — end_time gets the same treatment as start_time', () => {
  const row = buildActivityRow(
    {
      userId: 'u1',
      activity_name: 'gym',
      start_time: '2026-08-01T14:30:00',
      end_time: '2026-08-01T15:45:00',
    },
    'America/Chicago',
  );
  assert.equal(row.start_time, '2026-08-01T19:30:00.000Z');
  assert.equal(row.end_time, '2026-08-01T20:45:00.000Z');
});

test('buildActivityRow — an instant with an explicit offset passes through unchanged', () => {
  const row = buildActivityRow(
    { userId: 'u1', activity_name: 'walk', start_time: '2026-08-01T12:00:00Z' },
    'America/Chicago',
  );
  assert.equal(row.start_time, '2026-08-01T12:00:00.000Z');
});

test('buildActivityRow — absent start_time is stamped with the server clock', () => {
  const before = Date.now();
  const row = buildActivityRow({ userId: 'u1', activity_name: 'porch' }, 'America/Chicago');
  const stamped = new Date(row.start_time).getTime();
  assert.ok(!Number.isNaN(stamped), 'start_time must be a valid instant');
  assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000, 'start_time must be ~now');
});

test('buildActivityRow — empty-string start_time is stamped with the server clock', () => {
  const row = buildActivityRow({ userId: 'u1', activity_name: 'porch', start_time: '' }, 'America/Chicago');
  const stamped = new Date(row.start_time).getTime();
  assert.ok(Math.abs(stamped - Date.now()) < 5000);
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
