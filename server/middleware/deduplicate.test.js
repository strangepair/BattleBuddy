import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicate } from './deduplicate.js';

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
