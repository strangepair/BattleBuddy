// Unit tests for the agent's pipeline CRUD tools.
//
// Two things these lock down beyond the happy path:
//  1. The dev-mode gate — pipeline machinery must be unreachable from a normal
//     coaching turn, and the refusal must be legible enough that the model
//     tells the user to flip the toggle instead of inventing an excuse.
//  2. The honesty of the create result. "Filed" and "already tracked" and
//     "parked for review" are three different outcomes, and the whole point of
//     this tool is that the reply cannot round the last two up to the first.
//
// Supabase and Anthropic are injected, so nothing here touches a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_TOOLS,
  PIPELINE_TOOL_NAMES,
  PIPELINE_ACTIONS,
  executePipelineTool,
  mapCreateResult,
} from './pipelineTools.js';

const DEV = { devMode: true };

/** Minimal Supabase stand-in: only the query shapes these tools use. */
function fakeSupabase({ rows = [], onUpdate = () => {} } = {}) {
  const state = { rows: [...rows], updates: [] };
  const api = {
    from() { return api; },
    select() { return api; },
    eq() { return api; },
    in() { return api; },
    order() { return api; },
    limit() { return Promise.resolve({ data: state.rows, count: state.rows.length }); },
    single() { return Promise.resolve({ data: state.rows[0] ?? null }); },
    update(patch) { state.updates.push(patch); onUpdate(patch); return api; },
    _state: state,
  };
  return api;
}

test('every pipeline tool has a name, description and object schema', () => {
  assert.equal(PIPELINE_TOOLS.length, 4);
  for (const t of PIPELINE_TOOLS) {
    assert.ok(t.name, 'tool needs a name');
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.input_schema.type, 'object');
    assert.ok(Array.isArray(t.input_schema.required), `${t.name} must declare required[]`);
  }
  assert.deepEqual(
    [...PIPELINE_TOOL_NAMES].sort(),
    ['create_pipeline_item', 'get_pipeline_item', 'list_pipeline_items', 'update_pipeline_item'],
  );
});

test('update_pipeline_item advertises exactly the actions it implements', () => {
  const tool = PIPELINE_TOOLS.find((t) => t.name === 'update_pipeline_item');
  assert.deepEqual(tool.input_schema.properties.action.enum, PIPELINE_ACTIONS);
  assert.deepEqual([...PIPELINE_ACTIONS].sort(), ['cancel', 'expedite', 'resubmit', 'retry']);
});

// ─── The dev-mode gate ───────────────────────────────────────────────────────

test('every pipeline tool refuses when developer mode is off', async () => {
  for (const name of PIPELINE_TOOL_NAMES) {
    const r = await executePipelineTool(name, { text: 'x', id: 'i', action: 'cancel' }, {
      supabase: fakeSupabase(),
      devMode: false,
    });
    assert.equal(r.is_error, true, `${name} must refuse with dev mode off`);
    assert.equal(r.content.error, 'developer_mode_off');
    assert.match(r.content.meaning, /DEV toggle/);
    assert.match(r.content.meaning, /Do not claim anything was filed/i);
  }
});

test('the gate is checked before the store, so a missing DB cannot mask it', async () => {
  const r = await executePipelineTool('list_pipeline_items', {}, { supabase: null, devMode: false });
  assert.equal(r.content.error, 'developer_mode_off');
});

test('with dev mode on but no store, the error names the store', async () => {
  const r = await executePipelineTool('list_pipeline_items', {}, { supabase: null, ...DEV });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /unavailable/);
});

// ─── create_pipeline_item — the three distinct outcomes ──────────────────────

// mapCreateResult is where "filed" / "already tracked" / "parked" are kept
// distinct. The governed intake itself is covered by devPipeline.test.js.

test('a filed directive is reported as filed, with id, title and status', () => {
  const r = mapCreateResult({
    status: 200,
    body: {
      requests: [{
        id: 'row-1',
        title: 'Scroll calendar to current hour',
        status: 'pending',
        target: 'ui',
        created_at: '2026-08-08T00:00:00Z',
      }],
    },
  });
  assert.ok(!r.is_error);
  assert.equal(r.content.filed, true);
  assert.equal(r.content.count, 1);
  // The agent can only say "I filed X" honestly if the id and title come back.
  assert.equal(r.content.items[0].id, 'row-1');
  assert.equal(r.content.items[0].title, 'Scroll calendar to current hour');
  assert.equal(r.content.items[0].status, 'pending');
});

test('a deduped directive is NOT reported as filed', () => {
  const r = mapCreateResult({
    status: 200,
    body: { requests: [], deduped: true, message: 'Everything in that directive is already tracked' },
  });
  assert.equal(r.content.filed, false);
  assert.equal(r.content.duplicate, true);
  assert.match(r.content.meaning, /do NOT imply a new item was created/i);
});

test('a double-post is NOT reported as filed', () => {
  const r = mapCreateResult({ status: 200, body: { requests: [], duplicate: true } });
  assert.equal(r.content.filed, false);
  assert.equal(r.content.duplicate, true);
});

test('a parked directive is an error that says it is NOT being built', () => {
  // 422 = generation produced nothing usable; the raw text was parked instead.
  const r = mapCreateResult({
    status: 422,
    body: {
      error: 'That could not be turned into a build request. It has been saved for review, not lost.',
      reason: 'generation_empty',
      requests: [{ id: 'parked-1', title: 'unprocessed directive', status: 'needs_attention' }],
    },
  });
  assert.equal(r.is_error, true);
  assert.equal(r.content.ok, false);
  assert.equal(r.content.parked, true, 'the row exists — nothing vanished');
  assert.equal(r.content.reason, 'generation_empty');
  assert.match(r.content.meaning, /NOT turned into a build request/);
  assert.match(r.content.meaning, /do not tell the user it is being built/i);
});

test('a generation failure is parked, not silently dropped', () => {
  const r = mapCreateResult({
    status: 502,
    body: { error: 'saved for review', reason: 'generation_failed', requests: [{ id: 'p2', title: 't', status: 'needs_attention' }] },
  });
  assert.equal(r.is_error, true);
  assert.equal(r.content.parked, true);
});

test('create_pipeline_item requires text', async () => {
  const r = await executePipelineTool('create_pipeline_item', { text: '   ' }, {
    supabase: fakeSupabase(), ...DEV,
  });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /text is required/);
});

// ─── update_pipeline_item ────────────────────────────────────────────────────

test('update_pipeline_item rejects an unknown action without touching the store', async () => {
  let touched = false;
  const supabase = fakeSupabase({ onUpdate: () => { touched = true; } });
  const r = await executePipelineTool('update_pipeline_item', { id: 'x', action: 'delete' }, {
    supabase, ...DEV,
  });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /action must be one of/);
  assert.equal(touched, false);
});

test('update_pipeline_item requires both id and action', async () => {
  const r = await executePipelineTool('update_pipeline_item', { id: 'x' }, { supabase: fakeSupabase(), ...DEV });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /id and action are required/);
});

test('cancel marks the row superseded AND archived', async () => {
  const supabase = fakeSupabase({ rows: [{ id: 'r1', status: 'pending', history: [] }] });
  const r = await executePipelineTool('update_pipeline_item', { id: 'r1', action: 'cancel', note: 'not needed' }, {
    supabase, ...DEV,
  });
  assert.ok(!r.is_error, JSON.stringify(r.content));
  const patch = supabase._state.updates.at(-1);
  // Archiving alone would leave the worker free to dispatch it.
  assert.equal(patch.status, 'superseded');
  assert.equal(patch.archived, true);
  assert.ok(patch.history.some((h) => /not needed/.test(h.note || '')), 'the note is kept in history');
});

test('cancel is refused for an already-deployed item, and says so', async () => {
  const supabase = fakeSupabase({ rows: [{ id: 'r1', status: 'deployed', history: [] }] });
  const r = await executePipelineTool('update_pipeline_item', { id: 'r1', action: 'cancel' }, { supabase, ...DEV });
  assert.equal(r.is_error, true);
  assert.equal(r.content.refused, true, 'a 409 is a real answer, not a malfunction');
  assert.match(r.content.error, /deployed/);
});

test('retry is refused unless the item is failed or needs_attention', async () => {
  const supabase = fakeSupabase({ rows: [{ id: 'r1', status: 'building', history: [] }] });
  const r = await executePipelineTool('update_pipeline_item', { id: 'r1', action: 'retry' }, { supabase, ...DEV });
  assert.equal(r.is_error, true);
  assert.equal(r.content.refused, true);
  assert.match(r.content.error, /cannot resubmit/);
});

test('expedite sets the flag without changing status or the stage clock', async () => {
  const supabase = fakeSupabase({ rows: [{ id: 'r1', status: 'pending', history: [] }] });
  const r = await executePipelineTool('update_pipeline_item', { id: 'r1', action: 'expedite' }, { supabase, ...DEV });
  assert.ok(!r.is_error, JSON.stringify(r.content));
  const patch = supabase._state.updates.at(-1);
  assert.equal(patch.expedite, true);
  assert.equal(patch.status, undefined, 'expediting is a routing decision, not a stage transition');
  assert.equal(patch.entered_at, undefined, 'the stage-timeout clock must not be reset');
});

// ─── list / get ──────────────────────────────────────────────────────────────

test('list_pipeline_items slims rows and caps the limit', async () => {
  const big = { id: 'r1', title: 't', status: 'failed', error: 'x'.repeat(1000), spec: { huge: 'y'.repeat(50000) } };
  const supabase = fakeSupabase({ rows: [big] });
  const r = await executePipelineTool('list_pipeline_items', { filter: 'failed', limit: 9999 }, { supabase, ...DEV });
  const item = r.content.items[0];
  // The spec blob must never reach the model — a 128 KB tool payload is how
  // real numbers got buried on 2026-07-29.
  assert.equal(item.spec, undefined);
  assert.equal(item.error.length, 300, 'error text is truncated');
  assert.equal(item.status, 'failed');
});

test('get_pipeline_item needs an id and reports a miss as an error', async () => {
  const missing = await executePipelineTool('get_pipeline_item', {}, { supabase: fakeSupabase(), ...DEV });
  assert.equal(missing.is_error, true);
  assert.match(missing.content.error, /id is required/);

  const notFound = await executePipelineTool('get_pipeline_item', { id: 'nope' }, {
    supabase: fakeSupabase({ rows: [] }), ...DEV,
  });
  assert.equal(notFound.is_error, true);
});

test('an unknown tool name is reported, not silently ignored', async () => {
  const r = await executePipelineTool('drop_pipeline', {}, { supabase: fakeSupabase(), ...DEV });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /Unknown pipeline tool/);
});

// ─── Boot safety ─────────────────────────────────────────────────────────────

test('the module imports with no environment at all (container-boot safety)', async () => {
  // The outage class this guards: a module-scope createClient() throws during
  // ESM evaluation, which happens BEFORE index.js registers its
  // uncaughtException handler, so the process dies before server.listen().
  const saved = { ...process.env };
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) delete process.env[k];
  try {
    const mod = await import('./pipelineTools.js?boot-check');
    assert.ok(mod.PIPELINE_TOOLS.length > 0);
  } finally {
    Object.assign(process.env, saved);
  }
});
