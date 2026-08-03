import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicate, findActivityDuplicate } from './deduplicate.js';

function makeSupabase(rows) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        gte() { return this; },
        order() { return this; },
        limit() { return this; },
        async maybeSingle() {
          return { data: rows[0] || null, error: null };
        },
      };
    },
  };
}

function makeSupabaseMultiType(rowsByType) {
  return {
    from() {
      const state = { filters: [] };
      const chain = {
        select() { return this; },
        eq(col, val) { state.filters.push([col, val]); return this; },
        gte() { return this; },
        order() { return this; },
        limit() { return this; },
        async maybeSingle() {
          const typeFilter = state.filters.find(([col]) => col === 'event_type');
          const eventType = typeFilter ? typeFilter[1] : null;
          const rows = rowsByType[eventType] || [];
          return { data: rows[0] || null, error: null };
        },
      };
      return chain;
    },
  };
}

// (a) Identical rapid entries are deduplicated — findDuplicate returns an existing row
test('findDuplicate — returns existing row when one exists within window', async () => {
  const existing = {
    id: 'row-1',
    user_id: 'user-a',
    session_id: 'sess-1',
    event_type: 'voice_output_failure',
    payload: {},
    created_at: new Date().toISOString(),
  };
  const supabase = makeSupabase([existing]);

  const result = await findDuplicate(supabase, 'user-a', 'voice_output_failure', 90);
  assert.deepEqual(result, existing);
});

// (b) Same event type after the window creates a new entry — findDuplicate returns null
test('findDuplicate — returns null when no row exists within window', async () => {
  const supabase = makeSupabase([]);

  const result = await findDuplicate(supabase, 'user-a', 'voice_output_failure', 90);
  assert.equal(result, null);
});

// (c) Different event types within window both persist — each type checked independently
test('findDuplicate — different event types are not deduplicated against each other', async () => {
  const rowsByType = {
    voice_output_failure: [{
      id: 'row-1',
      user_id: 'user-a',
      session_id: 'sess-1',
      event_type: 'voice_output_failure',
      payload: {},
      created_at: new Date().toISOString(),
    }],
    voice_input_failure: [{
      id: 'row-2',
      user_id: 'user-a',
      session_id: 'sess-1',
      event_type: 'voice_input_failure',
      payload: {},
      created_at: new Date().toISOString(),
    }],
  };
  const supabase = makeSupabaseMultiType(rowsByType);

  const r1 = await findDuplicate(supabase, 'user-a', 'voice_output_failure', 90);
  const r2 = await findDuplicate(supabase, 'user-a', 'voice_input_failure', 90);

  assert.equal(r1.id, 'row-1');
  assert.equal(r2.id, 'row-2');
  assert.notEqual(r1.id, r2.id, 'different event types resolve independently');
});

// Error path — query error returns null (safe fallback, allow insert)
test('findDuplicate — returns null on supabase query error', async () => {
  const supabase = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        gte() { return this; },
        order() { return this; },
        limit() { return this; },
        async maybeSingle() {
          return { data: null, error: new Error('db unavailable') };
        },
      };
    },
  };

  const result = await findDuplicate(supabase, 'user-a', 'voice_output_failure', 90);
  assert.equal(result, null);
});

// ─── findActivityDuplicate — activities table ─────────────────────────────────

function makeActivitiesSupabase(rows) {
  return {
    from(table) {
      if (table !== 'activities') throw new Error(`unexpected table: ${table}`);
      return {
        select() { return this; },
        eq() { return this; },
        gte() { return this; },
        order() { return this; },
        limit() { return this; },
        async maybeSingle() {
          return { data: rows[0] || null, error: null };
        },
      };
    },
  };
}

function makeActivitiesSupabaseMultiName(rowsByName) {
  return {
    from(table) {
      if (table !== 'activities') throw new Error(`unexpected table: ${table}`);
      const state = { filters: [] };
      const chain = {
        select() { return this; },
        eq(col, val) { state.filters.push([col, val]); return this; },
        gte() { return this; },
        order() { return this; },
        limit() { return this; },
        async maybeSingle() {
          const nameFilter = state.filters.find(([col]) => col === 'activity_name');
          const name = nameFilter ? nameFilter[1] : null;
          const rows = rowsByName[name] || [];
          return { data: rows[0] || null, error: null };
        },
      };
      return chain;
    },
  };
}

// Scenario 1: duplicate within 60 s — blocked
test('findActivityDuplicate — returns existing row when one exists within 60s window', async () => {
  const existing = {
    id: 'act-1',
    user_id: 'user-a',
    activity_name: 'gym',
    start_time: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
  const supabase = makeActivitiesSupabase([existing]);

  const result = await findActivityDuplicate(supabase, 'user-a', 'gym', 60);
  assert.deepEqual(result, existing);
});

// Scenario 2: same type at 61 s — allowed (no row within window)
test('findActivityDuplicate — returns null when no row exists within 60s window (61s ago)', async () => {
  const supabase = makeActivitiesSupabase([]);

  const result = await findActivityDuplicate(supabase, 'user-a', 'gym', 60);
  assert.equal(result, null);
});

// Scenario 3: different activity name within 60 s — allowed
test('findActivityDuplicate — different activity names are not deduplicated against each other', async () => {
  const rowsByName = {
    gym: [{
      id: 'act-1',
      user_id: 'user-a',
      activity_name: 'gym',
      start_time: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }],
  };
  const supabase = makeActivitiesSupabaseMultiName(rowsByName);

  const gymResult = await findActivityDuplicate(supabase, 'user-a', 'gym', 60);
  const walkResult = await findActivityDuplicate(supabase, 'user-a', 'walk', 60);

  assert.equal(gymResult.id, 'act-1', 'gym within window is found');
  assert.equal(walkResult, null, 'walk (different type) within window is not blocked');
});
