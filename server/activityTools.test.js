// Unit tests for the agent's timeline CRUD tools.
//
// Run under TZ=UTC in CI — the same condition as production (Railway is UTC),
// which is exactly where the timezone bug these tools must not reintroduce
// shows up: a model-authored offset-less local time stored raw into a
// timestamptz column slides the entry by the user's whole offset.
//
// Supabase is injected, so nothing here touches a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMELINE_TOOLS, TIMELINE_TOOL_NAMES, executeTimelineTool } from './activityTools.js';

const TZ = 'America/Chicago';
const USER = 'mike';

/**
 * Chainable Supabase stand-in. `handler(state)` decides what a chain resolves
 * to, based on the table and which operation was invoked.
 */
function fakeDb(handler) {
  const calls = [];
  function builder(table) {
    const st = { table, op: 'select', payload: null, filters: {}, single: false };
    const b = {
      select() { return b; },
      eq(k, v) { st.filters[k] = v; return b; },
      gte(k, v) { st.filters[`gte_${k}`] = v; return b; },
      lte(k, v) { st.filters[`lte_${k}`] = v; return b; },
      order() { return b; },
      limit() { return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      delete() { st.op = 'delete'; return b; },
      single() { st.single = true; return b; },
      then(res, rej) { calls.push(st); return Promise.resolve(handler(st)).then(res, rej); },
    };
    return b;
  }
  return { db: { from: (t) => builder(t) }, calls };
}

test('every timeline tool has a name, description and object schema', () => {
  assert.equal(TIMELINE_TOOLS.length, 3);
  for (const t of TIMELINE_TOOLS) {
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.input_schema.type, 'object');
  }
  assert.deepEqual(
    [...TIMELINE_TOOL_NAMES].sort(),
    ['delete_activity', 'list_activities', 'update_activity'],
  );
});

test('the write tools require an id, so the model cannot edit "the last one"', () => {
  for (const name of ['update_activity', 'delete_activity']) {
    const t = TIMELINE_TOOLS.find((x) => x.name === name);
    assert.deepEqual(t.input_schema.required, ['id']);
  }
});

test('missing store or user is reported, not silently ignored', async () => {
  const noDb = await executeTimelineTool('list_activities', {}, { supabase: null, userId: USER });
  assert.equal(noDb.is_error, true);
  const noUser = await executeTimelineTool('list_activities', {}, { supabase: fakeDb(() => ({})).db, userId: null });
  assert.equal(noUser.is_error, true);
});

// ─── list_activities ─────────────────────────────────────────────────────────

test('list_activities returns local times and computed durations', async () => {
  const { db } = fakeDb(() => ({
    data: [{
      id: 'a1',
      activity_name: 'gym',
      // 2:30 PM–3:45 PM Central on 2026-08-01 == 19:30–20:45 UTC
      start_time: '2026-08-01T19:30:00.000Z',
      end_time: '2026-08-01T20:45:00.000Z',
      location: 'downtown',
    }],
    error: null,
  }));

  const r = await executeTimelineTool('list_activities', { date: '2026-08-01' }, {
    supabase: db, userId: USER, timezone: TZ,
  });

  const a = r.content.activities[0];
  assert.equal(r.content.date, '2026-08-01');
  assert.equal(a.duration_minutes, 75);
  // The sayable field must be the user's local clock, never the UTC instant.
  assert.match(a.local_time, /2:30/);
  assert.match(a.end_local_time, /3:45/);
  assert.ok(a.start_time.endsWith('Z'), 'the raw instant rides along for reference');
});

test('an open activity has no duration rather than a fabricated one', async () => {
  const { db } = fakeDb(() => ({
    data: [{ id: 'a1', activity_name: 'walk', start_time: '2026-08-01T19:30:00.000Z', end_time: null }],
    error: null,
  }));
  const r = await executeTimelineTool('list_activities', {}, { supabase: db, userId: USER, timezone: TZ });
  assert.equal(r.content.activities[0].duration_minutes, null);
  assert.equal(r.content.activities[0].end_local_time, null);
});

test("list_activities scopes the query to the user and to the day's local bounds", async () => {
  const { db, calls } = fakeDb(() => ({ data: [], error: null }));
  await executeTimelineTool('list_activities', { date: '2026-08-01' }, {
    supabase: db, userId: USER, timezone: TZ,
  });
  const q = calls[0];
  assert.equal(q.table, 'activities');
  assert.equal(q.filters.user_id, USER);
  // A Central day starts at 05:00 UTC — not at 00:00 UTC, which would return
  // the wrong 24 hours for every user west of Greenwich.
  assert.equal(q.filters.gte_start_time, '2026-08-01T05:00:00.000Z');
});

// ─── update_activity — the timezone contract ────────────────────────────────

test('update_activity re-anchors a local wall-clock time in the user timezone', async () => {
  const existing = { id: 'a1', activity_name: 'gym', start_time: '2026-08-01T19:30:00.000Z', end_time: null };
  const { db, calls } = fakeDb((st) => (st.op === 'update'
    ? { data: { ...existing, start_time: '2026-08-01T19:00:00.000Z' }, error: null }
    : { data: existing, error: null }));

  await executeTimelineTool('update_activity', { id: 'a1', start_time: '2026-08-01T14:00:00' }, {
    supabase: db, userId: USER, timezone: TZ,
  });

  const update = calls.find((c) => c.op === 'update');
  // 2 PM Central is 19:00Z. Storing the offset-less string raw would make it
  // 14:00Z and slide the whole entry five hours earlier on the calendar.
  assert.equal(update.payload.start_time, '2026-08-01T19:00:00.000Z');
});

test('a label-only correction does NOT re-stamp the times', async () => {
  const existing = { id: 'a1', activity_name: 'gym', start_time: '2026-08-01T19:30:00.000Z', end_time: null };
  const { db, calls } = fakeDb((st) => (st.op === 'update'
    ? { data: { ...existing, activity_name: 'lunch' }, error: null }
    : { data: existing, error: null }));

  await executeTimelineTool('update_activity', { id: 'a1', activity_name: 'lunch' }, {
    supabase: db, userId: USER, timezone: TZ,
  });

  const update = calls.find((c) => c.op === 'update');
  assert.deepEqual(Object.keys(update.payload), ['activity_name']);
  // normalizeOccurredAt(undefined) means "now" — a blanket normalize would
  // silently move this activity to the current time on a rename.
  assert.equal(update.payload.start_time, undefined);
  assert.equal(update.payload.end_time, undefined);
});

test('adding an end_time closes an open activity and gives it a duration', async () => {
  const existing = { id: 'a1', activity_name: 'gym', start_time: '2026-08-01T19:30:00.000Z', end_time: null };
  const { db } = fakeDb((st) => (st.op === 'update'
    ? { data: { ...existing, end_time: '2026-08-01T20:45:00.000Z' }, error: null }
    : { data: existing, error: null }));

  const r = await executeTimelineTool('update_activity', { id: 'a1', end_time: '2026-08-01T15:45:00' }, {
    supabase: db, userId: USER, timezone: TZ,
  });
  assert.ok(!r.is_error, JSON.stringify(r.content));
  assert.equal(r.content.activity.duration_minutes, 75);
});

test('an end before its start is refused rather than stored', async () => {
  const existing = { id: 'a1', activity_name: 'gym', start_time: '2026-08-01T19:30:00.000Z', end_time: null };
  const { db, calls } = fakeDb(() => ({ data: existing, error: null }));
  const r = await executeTimelineTool('update_activity', { id: 'a1', end_time: '2026-08-01T09:00:00' }, {
    supabase: db, userId: USER, timezone: TZ,
  });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /before start_time/);
  assert.equal(calls.find((c) => c.op === 'update'), undefined, 'nothing was written');
});

test('update_activity with no changed fields is refused', async () => {
  const existing = { id: 'a1', activity_name: 'gym', start_time: '2026-08-01T19:30:00.000Z' };
  const { db } = fakeDb(() => ({ data: existing, error: null }));
  const r = await executeTimelineTool('update_activity', { id: 'a1' }, {
    supabase: db, userId: USER, timezone: TZ,
  });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /nothing to update/);
});

test('update_activity on a row this user does not own is not found', async () => {
  const { db, calls } = fakeDb(() => ({ data: null, error: { message: 'no rows' } }));
  const r = await executeTimelineTool('update_activity', { id: 'someone-elses' }, {
    supabase: db, userId: USER, timezone: TZ,
  });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /not found/);
  // The service-role client bypasses RLS, so ownership has to be enforced here.
  assert.equal(calls[0].filters.user_id, USER);
  assert.equal(calls.find((c) => c.op === 'update'), undefined);
});

// ─── delete_activity ─────────────────────────────────────────────────────────

test('delete_activity names what it removed', async () => {
  const existing = { id: 'a1', activity_name: 'gym', start_time: '2026-08-01T19:30:00.000Z', end_time: null };
  const { db, calls } = fakeDb((st) => (st.op === 'delete' ? { error: null } : { data: existing, error: null }));

  const r = await executeTimelineTool('delete_activity', { id: 'a1' }, {
    supabase: db, userId: USER, timezone: TZ,
  });
  assert.ok(!r.is_error);
  assert.equal(r.content.deleted, 'a1');
  assert.equal(r.content.activity.activity_name, 'gym');
  assert.equal(calls.find((c) => c.op === 'delete').filters.user_id, USER);
});

test('deleting a row that is missing reports not-found instead of a false success', async () => {
  const { db, calls } = fakeDb(() => ({ data: null, error: null }));
  const r = await executeTimelineTool('delete_activity', { id: 'nope' }, {
    supabase: db, userId: USER, timezone: TZ,
  });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /not found/);
  // A bare delete would have removed zero rows and reported ok:true.
  assert.equal(calls.find((c) => c.op === 'delete'), undefined);
});

test('delete_activity requires an id', async () => {
  const { db } = fakeDb(() => ({ data: null }));
  const r = await executeTimelineTool('delete_activity', {}, { supabase: db, userId: USER });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /id is required/);
});

test('an unknown tool name is reported', async () => {
  const { db } = fakeDb(() => ({ data: null }));
  const r = await executeTimelineTool('truncate_activities', {}, { supabase: db, userId: USER });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /Unknown timeline tool/);
});

test('the module imports with no environment at all (container-boot safety)', async () => {
  const saved = { ...process.env };
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];
  try {
    const mod = await import('./activityTools.js?boot-check');
    assert.equal(mod.TIMELINE_TOOLS.length, 3);
  } finally {
    Object.assign(process.env, saved);
  }
});
