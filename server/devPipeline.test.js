// Unit tests for the Developer-mode pipeline's pure logic. No network / no
// external deps (devPipeline imports only node:crypto), so this runs green even
// where the full server dependency tree can't be installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, looksForbidden, patchForEvent, isPipelineEnabled, collapseNearDuplicates, generateProductRequests, insertRequests, insertSubmission, triageSubmission, handleRepetition, processSubmission } from './devPipeline.js';

test('dedupeKey is stable and target-scoped', () => {
  const a = dedupeKey('ui', 'Make the greeting warmer!');
  const b = dedupeKey('ui', 'make the greeting warmer');
  assert.equal(a, b, 'normalization ignores case/punctuation');
  assert.notEqual(a, dedupeKey('backend', 'Make the greeting warmer'), 'target changes the key');
  assert.match(a, /^ui:[0-9a-f]{16}$/);
});

test('looksForbidden catches protected areas', () => {
  assert.equal(looksForbidden('edit .github/workflows/deploy.yml'), true);
  assert.equal(looksForbidden('change the eas.json submit block'), true);
  assert.equal(looksForbidden('weaken the 988 off-ramp'), true);
  assert.equal(looksForbidden('rotate the API secret'), true);
  assert.equal(looksForbidden('make the greeting warmer'), false);
});

test('patchForEvent maps the lifecycle', () => {
  assert.equal(patchForEvent('pr_opened', { pr_url: 'x', pr_number: 3, branch: 'b' }).status, 'in_review');
  assert.equal(patchForEvent('checks_passed', {}).status, 'merging');
  assert.equal(patchForEvent('checks_failed', {}).status, 'failed');
  assert.equal(patchForEvent('merged', {}).status, 'deploying');
  assert.equal(patchForEvent('deployed', {}).status, 'deployed');
  assert.equal(patchForEvent('deploy_failed', {}).status, 'failed');
  assert.equal(patchForEvent('needs_attention', {}).status, 'needs_attention');
  assert.equal(patchForEvent('bogus', {}), null);
});

test('pipeline is off by default (inert until explicitly enabled)', () => {
  delete process.env.DEV_PIPELINE_ENABLED;
  assert.equal(isPipelineEnabled(), false);
  process.env.DEV_PIPELINE_ENABLED = 'true';
  assert.equal(isPipelineEnabled(), true);
  delete process.env.DEV_PIPELINE_ENABLED;
});

// ─── Truncation logging ───────────────────────────────────────────────────────

test('generateProductRequests logs and returns [] on max_tokens stop_reason', async () => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '[{"title":"partial' }],
      }),
    },
  };

  const result = await generateProductRequests(fakeAnthropic, { directiveText: 'do something' });

  console.error = origError;

  assert.deepEqual(result, []);
  assert.ok(errors.some((e) => e.includes('TRUNCATED') && e.includes('max_tokens')), 'should log truncation error');
});

test('generateProductRequests logs and returns [] on JSON.parse failure', async () => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '[not valid json]]' }],
      }),
    },
  };

  const result = await generateProductRequests(fakeAnthropic, { directiveText: 'do something' });

  console.error = origError;

  assert.deepEqual(result, []);
  assert.ok(errors.some((e) => e.includes('JSON.parse failed')), 'should log parse error');
});

// ─── In-batch near-duplicate collapse ────────────────────────────────────────

test('collapseNearDuplicates keeps higher-confidence item when overlap > 0.6', () => {
  const items = [
    { title: 'Add retry logic to fetch', description: 'Retry failed fetches automatically', target: 'backend', confidence: 0.7 },
    { title: 'Add retry logic to fetch', description: 'Retry failed fetches automatically in the backend', target: 'backend', confidence: 0.9 },
  ];
  const result = collapseNearDuplicates(items);
  assert.equal(result.length, 1);
  assert.equal(result[0].confidence, 0.9);
});

test('collapseNearDuplicates keeps both items when overlap <= 0.6', () => {
  const items = [
    { title: 'Add dark mode toggle', description: 'Allow users to switch to dark theme in settings', target: 'ui', confidence: 0.8 },
    { title: 'Fix login crash on Android', description: 'The app crashes when submitting login form', target: 'ui', confidence: 0.9 },
  ];
  const result = collapseNearDuplicates(items);
  assert.equal(result.length, 2);
});

test('collapseNearDuplicates does not collapse items with different targets', () => {
  const items = [
    { title: 'Add retry logic to fetch', description: 'Retry failed fetches automatically', target: 'backend', confidence: 0.7 },
    { title: 'Add retry logic to fetch', description: 'Retry failed fetches automatically', target: 'ui', confidence: 0.9 },
  ];
  const result = collapseNearDuplicates(items);
  assert.equal(result.length, 2);
});

// ─── Deployed-within-14-days skip ────────────────────────────────────────────

test('insertRequests skips task when dedupe_key has status=deployed within 14 days', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  const task = { title: 'Add retry logic', target: 'backend', confidence: 0.8, description: 'desc' };
  const key = dedupeKey(task.target, task.title);

  const insertedRows = [];
  const fakeSupabase = {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({
          data: [{ dedupe_key: key, status: 'deployed', updated_at: new Date().toISOString() }],
        }),
      }),
      insert: (rows) => {
        insertedRows.push(...rows);
        return { select: () => Promise.resolve({ data: rows, error: null }) };
      },
    }),
  };

  const result = await insertRequests(fakeSupabase, { source: 'test', userId: null, sessionId: null }, [task]);

  console.log = origLog;

  assert.deepEqual(result, []);
  assert.equal(insertedRows.length, 0, 'should not insert');
  assert.ok(logs.some((l) => l.includes('skip insert') && l.includes(key)), 'should log skip message');
});

// A stub whose dedupe lookup returns `existingRows` regardless of the keys asked
// for — enough of the supabase-js chain for insertRequests.
function stubSupabase(existingRows, insertedRows) {
  return {
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: existingRows }) }),
      insert: (rows) => {
        insertedRows.push(...rows);
        return { select: () => Promise.resolve({ data: rows, error: null }) };
      },
    }),
  };
}

test('insertRequests inserts task when no recently deployed row exists', async () => {
  const task = { title: 'New unique feature', target: 'ui', confidence: 0.85, description: 'desc' };
  const insertedRows = [];

  await insertRequests(stubSupabase([], insertedRows), { source: 'test', userId: null, sessionId: null }, [task]);

  assert.equal(insertedRows.length, 1, 'should insert the task');
});

test('insertRequests still skips a task whose dedupe_key is open (not yet deployed)', async () => {
  const task = { title: 'Half-built feature', target: 'backend', confidence: 0.8, description: 'desc' };
  const insertedRows = [];
  const existing = [{ dedupe_key: dedupeKey(task.target, task.title), status: 'building', updated_at: new Date().toISOString() }];

  await insertRequests(stubSupabase(existing, insertedRows), { source: 'test', userId: null, sessionId: null }, [task]);

  assert.equal(insertedRows.length, 0, 'an in-flight build must not be queued twice');
});

test('insertRequests re-admits a task deployed longer ago than the 14-day window', async () => {
  const task = { title: 'Seasonal tweak', target: 'ui', confidence: 0.8, description: 'desc' };
  const insertedRows = [];
  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const existing = [{ dedupe_key: dedupeKey(task.target, task.title), status: 'deployed', updated_at: longAgo }];

  await insertRequests(stubSupabase(existing, insertedRows), { source: 'test', userId: null, sessionId: null }, [task]);

  assert.equal(insertedRows.length, 1, 'an old deployment must not block the change forever');
});

test('insertRequests re-admits a task whose previous attempt failed', async () => {
  const task = { title: 'Retry me', target: 'backend', confidence: 0.8, description: 'desc' };
  const insertedRows = [];
  const existing = [{ dedupe_key: dedupeKey(task.target, task.title), status: 'failed', updated_at: new Date().toISOString() }];

  await insertRequests(stubSupabase(existing, insertedRows), { source: 'test', userId: null, sessionId: null }, [task]);

  assert.equal(insertedRows.length, 1, 'a failed build must be retryable');
});

// ─── Triage layer tests ───────────────────────────────────────────────────────

// Builds a minimal Supabase double that records inserted rows per table.
function makeTriageSupabase() {
  const store = {
    submissions: [],
    work_items: [],
    work_item_submissions: [],
    pipeline_events: [],
    dev_build_requests: [],
  };

  const makeTable = (tableName) => {
    let _filters = [];
    let _notFilters = [];
    let _orderBy = null;
    let _limitN = null;
    let _selectCols = '*';
    let _isSingle = false;
    let _pendingInsert = null;
    let _pendingUpdate = null;

    const self = {
      select(cols) { _selectCols = cols; return self; },
      insert(rows) {
        _pendingInsert = Array.isArray(rows) ? rows : [rows];
        return self;
      },
      update(patch) {
        _pendingUpdate = patch;
        return self;
      },
      eq(col, val) { _filters.push({ col, val }); return self; },
      not(col, op, val) { _notFilters.push({ col, op, val }); return self; },
      gte(col, val) { return self; },
      order() { return self; },
      limit(n) { _limitN = n; return self; },
      single() { _isSingle = true; return self; },
      then(resolve) {
        // handle insert
        if (_pendingInsert) {
          const rows = _pendingInsert.map((r) => ({ id: `uuid-${Date.now()}-${Math.random()}`, ...r }));
          store[tableName].push(...rows);
          const result = _isSingle
            ? { data: rows[0], error: null }
            : { data: rows, error: null };
          return Promise.resolve(result).then(resolve);
        }
        // handle update — apply the patch to matching rows so tests can assert
        // on post-update state (holdDuplicateRequests relies on this).
        if (_pendingUpdate) {
          let targets = store[tableName] || [];
          for (const f of _filters) targets = targets.filter((r) => r[f.col] === f.val);
          for (const row of targets) Object.assign(row, _pendingUpdate);
          return Promise.resolve({ data: targets, error: null }).then(resolve);
        }
        // handle select
        let rows = store[tableName].slice();
        for (const f of _filters) rows = rows.filter((r) => r[f.col] === f.val);
        for (const f of _notFilters) {
          if (f.op === 'in') {
            const vals = f.val.replace(/[()""]/g, '').split(',').map((s) => s.trim());
            rows = rows.filter((r) => !vals.includes(r[f.col]));
          }
        }
        if (_limitN) rows = rows.slice(0, _limitN);
        const result = _isSingle
          ? { data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } }
          : { data: rows, error: null };
        return Promise.resolve(result).then(resolve);
      },
    };
    return self;
  };

  const sb = {
    from: (tableName) => makeTable(tableName),
    _store: store,
  };
  return sb;
}

test('durability: submission row exists even when triage call throws', async () => {
  const sb = makeTriageSupabase();
  const badAnthropic = {
    messages: { create: async () => { throw new Error('anthropic down'); } },
  };

  const result = await processSubmission(sb, badAnthropic, {
    source: 'dev_mode',
    rawText: 'The voice assistant crashes on iOS 17',
    sessionId: null,
    insertedRequests: [],
    dispatchFn: null,
  });

  assert.equal(sb._store.submissions.length, 1, 'submission row must be written');
  assert.equal(result.isDuplicate, false, 'defaults to new on error');
});

test('duplicate path: attaches evidence, emits event, creates no build request', async () => {
  const existingItemId = 'existing-wi-id';
  const sb = makeTriageSupabase();
  sb._store.work_items.push({ id: existingItemId, title: 'Voice crashes on iOS', subsystem: 'voice', stage: 'received', created_at: new Date().toISOString() });

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ classification: 'duplicate', target_work_item_id: existingItemId }) }],
      }),
    },
  };

  let dispatchCalled = false;
  const result = await processSubmission(sb, fakeAnthropic, {
    source: 'dev_mode',
    rawText: 'App crashes on voice screen',
    sessionId: null,
    insertedRequests: [],
    dispatchFn: async () => { dispatchCalled = true; return 'req-1'; },
  });

  assert.equal(result.isDuplicate, true, 'should be marked duplicate');
  assert.equal(result.existingWorkItem.id, existingItemId);
  assert.equal(dispatchCalled, false, 'no dispatch for duplicate');
  assert.equal(sb._store.work_item_submissions.length, 1, 'evidence link created');
  assert.equal(sb._store.work_item_submissions[0].role, 'evidence');
  assert.equal(sb._store.pipeline_events.length, 1, 'one pipeline_event emitted');
});

// Regression: the /dev/directive handler inserts dev_build_requests rows BEFORE
// triage runs, and runDevBuildWorker dispatches anything still in 'pending'.
// A duplicate therefore used to ship a second, identical build even though the
// duplicate path returned early. The rows must be parked in a terminal status.
test('duplicate path: parks pre-created build requests so no redundant build is dispatched', async () => {
  const existingItemId = 'existing-wi-id';
  const sb = makeTriageSupabase();
  sb._store.work_items.push({ id: existingItemId, title: 'Voice crashes on iOS', subsystem: 'voice', stage: 'received', created_at: new Date().toISOString() });
  // The row insertRequests() already wrote before triage ran.
  sb._store.dev_build_requests.push({ id: 'req-dup', status: 'pending', history: [] });

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ classification: 'duplicate', target_work_item_id: existingItemId }) }],
      }),
    },
  };

  const result = await processSubmission(sb, fakeAnthropic, {
    source: 'dev_mode',
    rawText: 'App crashes on voice screen',
    sessionId: null,
    insertedRequests: [{ id: 'req-dup' }],
    dispatchFn: async () => 'req-dup',
  });

  assert.equal(result.isDuplicate, true);
  const parked = sb._store.dev_build_requests.find((r) => r.id === 'req-dup');
  assert.equal(parked.status, 'duplicate', 'build request must leave pending');
  // runDevBuildWorker selects .eq('status', 'pending') — nothing left for it.
  const stillPending = sb._store.dev_build_requests.filter((r) => r.status === 'pending');
  assert.deepEqual(stillPending, [], 'no pending row left for the build worker');
  assert.match(
    parked.history.at(-1).note,
    /duplicate of work item/,
    'parking must be traceable in history',
  );
});

test('new path: leaves the pre-created build request pending for the worker', async () => {
  const sb = makeTriageSupabase();
  sb._store.dev_build_requests.push({ id: 'req-new', status: 'pending', history: [] });

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ classification: 'new', title: 'Fix voice crash', interpretation: 'Voice crashes', subsystem: 'voice' }) }],
      }),
    },
  };

  await processSubmission(sb, fakeAnthropic, {
    source: 'dev_mode',
    rawText: 'Voice crashes on iOS 17',
    sessionId: null,
    insertedRequests: [{ id: 'req-new' }],
    dispatchFn: async () => 'req-new',
  });

  const row = sb._store.dev_build_requests.find((r) => r.id === 'req-new');
  assert.equal(row.status, 'pending', 'a genuinely new request must still build');
});

test('new path: creates work_item + calls dispatchFn', async () => {
  const sb = makeTriageSupabase();
  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ classification: 'new', title: 'Fix voice crash', interpretation: 'Voice crashes on iOS 17', subsystem: 'voice' }) }],
      }),
    },
  };

  let dispatchedId = null;
  const result = await processSubmission(sb, fakeAnthropic, {
    source: 'dev_mode',
    rawText: 'Voice crashes on iOS 17',
    sessionId: null,
    insertedRequests: [{ id: 'req-42' }],
    dispatchFn: async () => { dispatchedId = 'req-42'; return 'req-42'; },
  });

  assert.equal(result.isDuplicate, false);
  assert.ok(result.workItem, 'work_item returned');
  assert.equal(sb._store.work_items.length, 1, 'one work_item created');
  assert.equal(sb._store.work_items[0].title, 'Fix voice crash');
  assert.equal(sb._store.work_item_submissions[0].role, 'origin');
  assert.equal(dispatchedId, 'req-42', 'dispatchFn was called');
  const buildEvent = sb._store.pipeline_events.find((e) => e.kind === 'build_started');
  assert.ok(buildEvent, 'build_started event emitted');
  assert.equal(buildEvent.detail.requestId, 'req-42');
});

test('invalid JSON from model defaults to new on second failure (no stall)', async () => {
  const sb = makeTriageSupabase();
  let callCount = 0;
  const fakeAnthropic = {
    messages: {
      create: async () => {
        callCount++;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json at all' }] };
      },
    },
  };

  const result = await triageSubmission(fakeAnthropic, { rawText: 'test', openWorkItems: [] });

  assert.equal(result.classification, 'new', 'must default to new');
  assert.equal(callCount, 2, 'must retry once');
});

test('triage timeout defaults to new', async () => {
  const fakeAnthropic = {
    messages: {
      create: async (_body, opts) => {
        if (opts?.signal) {
          return new Promise((_res, rej) => {
            opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        }
        return new Promise(() => {});
      },
    },
  };

  const originalTimeout = globalThis.setTimeout;
  let abortFn;
  globalThis.setTimeout = (fn, _ms) => { abortFn = fn; return 1; };
  globalThis.clearTimeout = () => {};

  const triagePromise = triageSubmission(fakeAnthropic, { rawText: 'test', openWorkItems: [] });
  if (abortFn) abortFn();
  globalThis.setTimeout = originalTimeout;

  const result = await triagePromise;
  assert.equal(result.classification, 'new', 'timeout must default to new');
});

test('repetition marker: creates root-cause item when >= 3 items for subsystem in 7 days', async () => {
  const sb = makeTriageSupabase();
  const now = new Date().toISOString();
  sb._store.work_items.push(
    { id: 'wi-1', subsystem: 'voice', stage: 'received', created_at: now, title: 'a' },
    { id: 'wi-2', subsystem: 'voice', stage: 'received', created_at: now, title: 'b' },
    { id: 'wi-3', subsystem: 'voice', stage: 'received', created_at: now, title: 'c' },
  );

  await handleRepetition(sb, 'voice');

  const rcItem = sb._store.work_items.find((w) => w.title === 'Root-cause investigation: voice');
  assert.ok(rcItem, 'root-cause work item created');
  assert.equal(rcItem.subsystem, 'pipeline');
  const rcEvent = sb._store.pipeline_events.find((e) => e.detail?.reason === 'repetition_marker');
  assert.ok(rcEvent, 'repetition_marker event emitted');
});

test('repetition marker: does not create duplicate if investigation already open', async () => {
  const sb = makeTriageSupabase();
  const now = new Date().toISOString();
  sb._store.work_items.push(
    { id: 'wi-1', subsystem: 'voice', stage: 'received', created_at: now, title: 'a' },
    { id: 'wi-2', subsystem: 'voice', stage: 'received', created_at: now, title: 'b' },
    { id: 'wi-3', subsystem: 'voice', stage: 'received', created_at: now, title: 'c' },
    { id: 'wi-rc', subsystem: 'pipeline', stage: 'received', created_at: now, title: 'Root-cause investigation: voice' },
  );

  await handleRepetition(sb, 'voice');

  const rcItems = sb._store.work_items.filter((w) => w.title === 'Root-cause investigation: voice');
  assert.equal(rcItems.length, 1, 'must not create a second investigation');
});
