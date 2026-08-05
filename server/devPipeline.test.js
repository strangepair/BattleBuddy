// Unit tests for the Developer-mode pipeline's pure logic. No network / no
// external deps (devPipeline imports only node:crypto), so this runs green even
// where the full server dependency tree can't be installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, looksForbidden, patchForEvent, isPipelineEnabled, collapseNearDuplicates, generateProductRequests, insertRequests, insertSubmission, triageSubmission, handleRepetition, processSubmission, classifyFailure, failureSignature, retryDelayMs, applyFailure, runDevBuildWorker, resubmitPlan, RESUBMITTABLE, parkUnprocessedDirective, titleSimilarity, handleDevPipeline, workerStatus, sweepStageTimeouts, runWorkerWatchdog } from './devPipeline.js';

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

// ─── Self-heal: classified retry + circuit breaker ────────────────────────────

// A fuller Supabase double: filters, counts, updates and the partial-unique
// behaviour of pipeline_alerts (one open row per signature).
function makeSelfHealSupabase(seed = {}) {
  const store = {
    dev_build_requests: seed.dev_build_requests ?? [],
    pipeline_alerts: seed.pipeline_alerts ?? [],
  };

  const table = (name) => {
    const preds = [];
    let mode = 'select';
    let patch = null;
    let insertRows = null;
    let single = false;
    let head = false;
    let limitN = null;

    const self = {
      select(_cols, opt) { mode = 'select'; if (opt && opt.head) head = true; return self; },
      insert(rows) { mode = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return self; },
      update(p) { mode = 'update'; patch = p; return self; },
      eq(c, v) { preds.push((r) => r[c] === v); return self; },
      neq(c, v) { preds.push((r) => r[c] !== v); return self; },
      in(c, vals) { preds.push((r) => vals.includes(r[c])); return self; },
      gte(c, v) { preds.push((r) => String(r[c] ?? '') >= String(v)); return self; },
      lte(c, v) { preds.push((r) => String(r[c] ?? '') <= String(v)); return self; },
      is(c, v) { preds.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return self; },
      not(c, op, v) {
        if (op === 'is' && v === null) preds.push((r) => r[c] !== null && r[c] !== undefined);
        else if (op === 'in') {
          const vals = String(v).replace(/[()"]/g, '').split(',').map((s) => s.trim());
          preds.push((r) => !vals.includes(r[c]));
        }
        return self;
      },
      order() { return self; },
      limit(n) { limitN = n; return self; },
      single() { single = true; return self; },
      then(resolve) {
        const matching = () => {
          let out = (store[name] || []).filter((r) => preds.every((f) => f(r)));
          if (limitN != null) out = out.slice(0, limitN);
          return out;
        };

        if (mode === 'insert') {
          for (const row of insertRows) {
            // Mirrors the partial unique index: one OPEN alert per signature.
            if (name === 'pipeline_alerts'
              && store.pipeline_alerts.some((a) => a.signature === row.signature && !a.resolved_at)) {
              return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint' } }).then(resolve);
            }
            store[name].push({ id: `id-${store[name].length + 1}`, resolved_at: null, ...row });
          }
          return Promise.resolve({ data: insertRows, error: null }).then(resolve);
        }

        if (mode === 'update') {
          const targets = matching();
          for (const r of targets) Object.assign(r, patch);
          return Promise.resolve({ data: targets, error: null }).then(resolve);
        }

        const out = matching();
        if (head) return Promise.resolve({ count: out.length, data: null, error: null }).then(resolve);
        if (single) return Promise.resolve({ data: out[0] || null, error: out[0] ? null : { message: 'not found' } }).then(resolve);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return self;
  };

  return { from: table, _store: store };
}

test('classifyFailure: terminal wins even when the text also looks transient', () => {
  assert.equal(classifyFailure('scope fence violation: ETIMEDOUT on protected path'), 'terminal');
  assert.equal(classifyFailure('Destructive migration detected — refusing to auto-apply.'), 'terminal');
});

test('classifyFailure: transient infra flakes and stale branches are separated', () => {
  assert.equal(classifyFailure('connect ETIMEDOUT downloading onnxruntime'), 'transient');
  assert.equal(classifyFailure('psql: error: connection ... Network is unreachable'), 'transient');
  assert.equal(classifyFailure('github dispatch 503: service unavailable'), 'transient');
  assert.equal(classifyFailure('merge conflict in server/migrations'), 'stale_branch');
  assert.equal(classifyFailure('PR is not mergeable (dirty)'), 'stale_branch');
});

test('classifyFailure: anything unrecognised stays terminal, never blanket-retried', () => {
  assert.equal(classifyFailure('something nobody has seen before'), 'terminal');
  assert.equal(classifyFailure(''), 'terminal');
  assert.equal(classifyFailure(undefined), 'terminal');
});

test('failureSignature collapses volatile ids so repeats share one key', () => {
  const a = failureSignature('deploy_failed', 'run 30729006919 failed for 49db9246-b357-4b24-a8c6-b9516158c968 at /home/runner/x.sql');
  const b = failureSignature('deploy_failed', 'run 30753987877 failed for a43d0e91-f08c-42ae-ace4-7049a238e057 at /home/runner/y.sql');
  assert.equal(a.signature, b.signature, 'same failure, different ids → same signature');

  const other = failureSignature('checks_failed', 'totally different problem');
  assert.notEqual(a.signature, other.signature);
});

test('retryDelayMs backs off exponentially', () => {
  assert.ok(retryDelayMs(1) > retryDelayMs(0));
  assert.equal(retryDelayMs(1), retryDelayMs(0) * 2);
});

test('applyFailure schedules a retry for a transient failure', async () => {
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{ id: 'r1', status: 'building', attempts: 0, history: [] }],
  });

  await applyFailure(sb, 'r1', { status: 'failed', error: 'connect ETIMEDOUT' }, 'deploy failed', 'deploy_failed');

  const row = sb._store.dev_build_requests[0];
  assert.equal(row.failure_class, 'transient');
  assert.ok(row.failure_signature, 'signature recorded');
  assert.ok(row.next_retry_at, 'retry scheduled');
});

test('applyFailure leaves a terminal failure with no retry scheduled', async () => {
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{ id: 'r1', status: 'building', attempts: 0, history: [] }],
  });

  await applyFailure(sb, 'r1', { status: 'needs_attention', error: 'Destructive migration detected' }, 'blocked', 'needs_attention');

  const row = sb._store.dev_build_requests[0];
  assert.equal(row.failure_class, 'terminal');
  assert.equal(row.next_retry_at, null, 'scope-fence class must never self-retry');
});

test('applyFailure stops retrying once the per-class cap is reached', async () => {
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{ id: 'r1', status: 'building', attempts: 2, history: [] }],
  });

  await applyFailure(sb, 'r1', { status: 'failed', error: 'connect ETIMEDOUT' }, 'deploy failed', 'deploy_failed');

  assert.equal(sb._store.dev_build_requests[0].next_retry_at, null, 'transient cap is 2 attempts');
});

test('circuit breaker: N same-signature failures raise ONE alert and halt retries', async () => {
  const now = new Date().toISOString();
  const err = 'connect ETIMEDOUT';
  const { signature } = failureSignature('deploy_failed', err);

  // Two rows have already failed the same way; this is the third.
  const sb = makeSelfHealSupabase({
    dev_build_requests: [
      { id: 'r1', status: 'failed', attempts: 0, history: [], failure_signature: signature, failure_class: 'transient', next_retry_at: now, updated_at: now },
      { id: 'r2', status: 'failed', attempts: 0, history: [], failure_signature: signature, failure_class: 'transient', next_retry_at: now, updated_at: now },
      { id: 'r3', status: 'building', attempts: 0, history: [], updated_at: now },
    ],
  });

  await applyFailure(sb, 'r3', { status: 'failed', error: err }, 'deploy failed', 'deploy_failed');

  const alerts = sb._store.pipeline_alerts.filter((a) => !a.resolved_at);
  assert.equal(alerts.length, 1, 'one alert, not one per row');
  assert.equal(alerts[0].kind, 'repeated_failure');
  assert.equal(alerts[0].signature, signature);

  for (const row of sb._store.dev_build_requests) {
    assert.equal(row.next_retry_at, null, `${row.id} must stop retrying once the breaker is open`);
  }
  assert.ok(
    sb._store.dev_build_requests.filter((r) => r.status === 'needs_attention').length >= 2,
    'failed rows are escalated to a human',
  );
});

test('circuit breaker does not double-alert on a later failure with the same signature', async () => {
  const now = new Date().toISOString();
  const err = 'connect ETIMEDOUT';
  const { signature } = failureSignature('deploy_failed', err);

  const sb = makeSelfHealSupabase({
    dev_build_requests: [
      { id: 'r1', status: 'failed', attempts: 0, history: [], failure_signature: signature, updated_at: now },
      { id: 'r2', status: 'failed', attempts: 0, history: [], failure_signature: signature, updated_at: now },
      { id: 'r3', status: 'building', attempts: 0, history: [], updated_at: now },
    ],
    pipeline_alerts: [{ id: 'a1', kind: 'repeated_failure', signature, resolved_at: null }],
  });

  await applyFailure(sb, 'r3', { status: 'failed', error: err }, 'deploy failed', 'deploy_failed');

  assert.equal(sb._store.pipeline_alerts.filter((a) => !a.resolved_at).length, 1);
  assert.equal(sb._store.dev_build_requests.find((r) => r.id === 'r3').next_retry_at, null,
    'no retry scheduled while the breaker is open');
});

test('worker retry pass re-dispatches a due transient failure and clears its alert', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { signature } = failureSignature('dispatch', 'connect ETIMEDOUT');
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{
      id: 'r1', status: 'failed', attempts: 0, history: [], target: 'ui', title: 't', spec: {},
      failure_class: 'transient', failure_signature: signature, next_retry_at: past,
      created_at: new Date().toISOString(), updated_at: past,
    }],
    pipeline_alerts: [{ id: 'a1', kind: 'repeated_failure', signature, resolved_at: null }],
  });

  const prevEnabled = process.env.DEV_PIPELINE_ENABLED;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.DEV_PIPELINE_ENABLED = 'true';
  process.env.GITHUB_TOKEN = 'test-token';
  globalThis.fetch = async () => ({ ok: true, text: async () => '' });

  try {
    await runDevBuildWorker({ supabase: sb });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnabled === undefined) delete process.env.DEV_PIPELINE_ENABLED; else process.env.DEV_PIPELINE_ENABLED = prevEnabled;
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevToken;
  }

  const row = sb._store.dev_build_requests[0];
  assert.equal(row.status, 'building', 'due transient failure must be re-dispatched');
  assert.equal(row.attempts, 1, 'attempt count incremented');
  assert.equal(row.next_retry_at, null);
  assert.ok(sb._store.pipeline_alerts[0].resolved_at, 'a success closes the breaker');
});

test('worker retry pass ignores terminal failures entirely', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{
      id: 'r1', status: 'failed', attempts: 0, history: [], target: 'ui', title: 't', spec: {},
      failure_class: 'terminal', failure_signature: 'x', next_retry_at: past,
      created_at: new Date().toISOString(), updated_at: past,
    }],
  });

  const prevEnabled = process.env.DEV_PIPELINE_ENABLED;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.DEV_PIPELINE_ENABLED = 'true';
  process.env.GITHUB_TOKEN = 'test-token';
  let dispatched = 0;
  globalThis.fetch = async () => { dispatched += 1; return { ok: true, text: async () => '' }; };

  try {
    await runDevBuildWorker({ supabase: sb });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnabled === undefined) delete process.env.DEV_PIPELINE_ENABLED; else process.env.DEV_PIPELINE_ENABLED = prevEnabled;
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevToken;
  }

  assert.equal(dispatched, 0, 'a scope-fence/destructive failure must never be auto-retried');
  assert.equal(sb._store.dev_build_requests[0].status, 'failed');
});

// ─── Manual resubmit routing ─────────────────────────────────────────────────

test('resubmitPlan re-runs the deploy when the code already merged', () => {
  // The change is on main; regenerating it would write the same edit twice.
  assert.equal(
    resubmitPlan({ status: 'failed', deploy_status: 'failed', pr_number: 77 }),
    'rerun_deploy',
  );
});

test('resubmitPlan rebuilds when CI failed or the branch went stale', () => {
  assert.equal(resubmitPlan({ status: 'failed', checks_status: 'failed', pr_number: 77 }), 'redispatch_build');
  assert.equal(resubmitPlan({ status: 'failed', failure_class: 'stale_branch', pr_number: 77 }), 'redispatch_build');
  assert.equal(resubmitPlan({ status: 'failed' }), 'redispatch_build', 'no PR yet → fresh build');
});

test('resubmitPlan will not re-run a deploy it cannot locate', () => {
  // deploy_status failed but no PR number: there is no merge commit to find.
  assert.equal(resubmitPlan({ status: 'failed', deploy_status: 'failed' }), 'redispatch_build');
});

test('only stuck requests are resubmittable', () => {
  assert.deepEqual(RESUBMITTABLE, ['failed', 'needs_attention']);
  assert.ok(!RESUBMITTABLE.includes('building'), 'an in-flight build must not be double-dispatched');
  assert.ok(!RESUBMITTABLE.includes('deployed'));
});


// ─── Backlog hygiene: near-duplicate collapse + never losing a directive ─────

/** Minimal double supporting the chains insertRequests actually uses. */
function dedupSupabase(openRows) {
  const inserted = [];
  const chain = (rows) => {
    let mode = 'select';
    let batch = null;
    let single = false;
    const self = {
      select: () => self,
      gte: () => self,
      in: () => self,
      insert(r) { mode = 'insert'; batch = Array.isArray(r) ? r : [r]; inserted.push(...batch); return self; },
      single() { single = true; return self; },
      then(resolve) {
        // An insert().select() RETURNS the inserted rows, not the query rows —
        // conflating the two made the dedup assertions meaningless.
        const data = mode === 'insert' ? (single ? { id: 'new-row', ...batch[0] } : batch) : rows;
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return self;
  };
  return { from: () => chain(openRows), _inserted: inserted };
}

test('insertRequests collapses a reworded duplicate of an open row', async () => {
  // The three real backlog rows this prevents:
  //   "Calendar: show only current-day logs; enable full scroll"
  //   "Calendar view: show only current day's logged activities"
  //   "Calendar: show only current-day logs; make timeline scrollable"
  // Same ask, three wordings, three different dedupe_key hashes, three rows.
  const supabase = dedupSupabase([
    { title: 'Calendar: show only current-day logs; enable full scroll', target: 'ui', status: 'pending' },
  ]);
  const result = await insertRequests(supabase, { source: 'directive', userId: null, sessionId: null }, [
    { title: "Calendar view: show only current day's logged activities", description: 'calendar shows only current day logs', target: 'ui', confidence: 0.9 },
  ]);
  assert.deepEqual(result, [], 'the reworded duplicate is collapsed, not inserted');
});

test('insertRequests still admits a genuinely different ask on the same surface', async () => {
  const supabase = dedupSupabase([
    { title: 'Calendar: show only current-day logs; enable full scroll', target: 'ui', status: 'pending' },
  ]);
  const result = await insertRequests(supabase, { source: 'directive', userId: null, sessionId: null }, [
    { title: 'Add a Jump to Now button on the dashboard', description: 'scroll the timeline back to the present moment', target: 'ui', confidence: 0.9 },
  ]);
  assert.equal(result.length, 1, 'a different ask must still get through');
});

test('a directive the generator cannot parse is parked, never dropped', async () => {
  const supabase = dedupSupabase([]);
  const text = 'Supabase composite index on sessions(user_id, created_at DESC)';
  const row = await parkUnprocessedDirective(supabase, { userId: 'u1' }, text, 'spec generation returned nothing');

  const written = supabase._inserted[0];
  assert.equal(written.status, 'needs_attention', 'it lands somewhere a human will see it');
  assert.equal(written.spec.rawDirective, text, 'the original wording survives verbatim');
  assert.equal(written.spec.unprocessed, true);
  assert.match(written.error, /Could not be turned into a build request/);
  assert.ok(row, 'and the row is returned so the endpoint can show it');
});

test('titleSimilarity scores the real backlog duplicates above the threshold', () => {
  // Both pairs are actual rows that coexisted in the pending backlog.
  assert.ok(titleSimilarity(
    'Calendar: show only current-day logs; enable full scroll',
    "Calendar view: show only current day's logged activities",
  ) >= 0.6);
  assert.ok(titleSimilarity(
    'Add start_time and end_time fields to logged events schema (additive migration)',
    'Add start_time and end_time fields to activity/event log schema (additive)',
  ) >= 0.6);
});

test('titleSimilarity leaves genuinely different asks alone', () => {
  assert.ok(titleSimilarity(
    'Calendar: show only current-day logs; enable full scroll',
    "Add a 'Jump to Now' button on the Mission Dashboard",
  ) < 0.6);
  assert.ok(titleSimilarity(
    'Agent boot heartbeat: agent.py POST + server /agent/heartbeat',
    'Add Supabase index on sessions(user_id, created_at) for pagination',
  ) < 0.6);
  assert.equal(titleSimilarity('', 'anything'), 0);
});

// ─── GET /dev/requests — total + data shape ───────────────────────────────────

function makeRequestsSupabase(rows) {
  const store = { dev_build_requests: rows };
  const table = (name) => {
    const preds = [];
    let head = false;
    let limitN = null;

    const self = {
      select(_cols, opt) { if (opt && opt.head) head = true; return self; },
      in(c, vals) { preds.push((r) => vals.includes(r[c])); return self; },
      order() { return self; },
      limit(n) { limitN = n; return self; },
      then(resolve) {
        let out = (store[name] || []).filter((r) => preds.every((f) => f(r)));
        const total = out.length;
        if (limitN != null) out = out.slice(0, limitN);
        if (head) return Promise.resolve({ count: total, data: null, error: null }).then(resolve);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return self;
  };
  return { from: table };
}

function makeDevDeps(supabase) {
  return {
    CORS: {},
    checkClientToken: () => true,
    checkAdminSecret: () => true,
    anthropic: null,
    supabase,
    resolveUserId: (id) => id,
  };
}

async function callListRequests(supabase, queryString = '') {
  let statusCode;
  let body;
  const req = { method: 'GET', url: `http://x/dev/requests${queryString}`, headers: {} };
  const res = {
    writeHead(s) { statusCode = s; },
    end(b) { body = JSON.parse(b); },
  };
  await handleDevPipeline(req, res, makeDevDeps(supabase));
  return { statusCode, body };
}

test('GET /dev/requests returns total and data fields', async () => {
  const rows = [
    { id: 'r1', status: 'pending', created_at: '2024-01-03T00:00:00Z' },
    { id: 'r2', status: 'pending', created_at: '2024-01-02T00:00:00Z' },
  ];
  const { statusCode, body } = await callListRequests(makeRequestsSupabase(rows));
  assert.equal(statusCode, 200);
  assert.equal(typeof body.total, 'number', 'total must be a number');
  assert.ok(Array.isArray(body.data), 'data must be an array');
});

test('GET /dev/requests: total equals data length when records <= limit', async () => {
  const rows = [
    { id: 'r1', status: 'pending', created_at: '2024-01-03T00:00:00Z' },
    { id: 'r2', status: 'pending', created_at: '2024-01-02T00:00:00Z' },
  ];
  const { body } = await callListRequests(makeRequestsSupabase(rows));
  assert.equal(body.total, body.data.length, 'total equals data length when no truncation');
});

test('GET /dev/requests: total is greater than data length when records exceed limit', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    status: 'pending',
    created_at: new Date(2024, 0, 5 - i).toISOString(),
  }));
  const { body } = await callListRequests(makeRequestsSupabase(rows), '?limit=2');
  assert.equal(body.data.length, 2, 'data is capped by limit');
  assert.equal(body.total, 5, 'total reflects the full count');
  assert.ok(body.total > body.data.length, 'total > data.length when truncated');
});

test('GET /dev/requests: status filter is applied to both total and data', async () => {
  const rows = [
    { id: 'r1', status: 'pending', created_at: '2024-01-03T00:00:00Z' },
    { id: 'r2', status: 'deployed', created_at: '2024-01-02T00:00:00Z' },
    { id: 'r3', status: 'pending', created_at: '2024-01-01T00:00:00Z' },
  ];
  const { body } = await callListRequests(makeRequestsSupabase(rows), '?status=pending');
  assert.equal(body.total, 2, 'total counts only matching status rows');
  assert.equal(body.data.length, 2, 'data contains only matching status rows');
  assert.ok(body.data.every((r) => r.status === 'pending'), 'all data rows match the status filter');
});

// ─── Dispatcher: the stalls that were invisible from outside the container ───
//
// 2026-08-05: a full queue, a free slot, and no dispatch for hours. The tick was
// alive the whole time — ghost rows held every slot — but nothing said so. These
// cover the three ways the dispatcher can go quiet AND the heartbeat that now
// makes each of them legible.

/** Run one worker tick with the pipeline switched on and GitHub stubbed. */
async function runWorkerWith(sb, { dispatchFails = false } = {}) {
  const prevEnabled = process.env.DEV_PIPELINE_ENABLED;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.DEV_PIPELINE_ENABLED = 'true';
  process.env.GITHUB_TOKEN = 'test-token';
  let dispatched = 0;
  globalThis.fetch = async () => {
    dispatched += 1;
    return dispatchFails
      ? { ok: false, status: 500, text: async () => 'boom' }
      : { ok: true, text: async () => '' };
  };
  try {
    await runDevBuildWorker({ supabase: sb });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnabled === undefined) delete process.env.DEV_PIPELINE_ENABLED; else process.env.DEV_PIPELINE_ENABLED = prevEnabled;
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevToken;
  }
  return dispatched;
}

const pendingRow = (over = {}) => ({
  id: 'p1', status: 'pending', archived: false, attempts: 0, history: [],
  target: 'ui', title: 't', spec: {},
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...over,
});

test('worker dispatches a pending row when a slot is free', async () => {
  const sb = makeSelfHealSupabase({ dev_build_requests: [pendingRow()] });
  const dispatched = await runWorkerWith(sb);

  assert.equal(dispatched, 1, 'a free slot with a queued row must produce a dispatch');
  assert.equal(sb._store.dev_build_requests[0].status, 'building');
  const st = workerStatus();
  assert.equal(st.gates.dispatched, 1);
  assert.equal(st.starved, false);
});

test('an archived row at the head of the queue no longer starves the rows behind it', async () => {
  // The regression: `.limit(slots)` selected the archived row, the archived
  // filter then dropped it, and the tick dispatched nothing — every tick,
  // forever, with DEV_MAX_CONCURRENT=1.
  const sb = makeSelfHealSupabase({
    dev_build_requests: [
      pendingRow({ id: 'archived-head', archived: true, created_at: '2020-01-01T00:00:00Z' }),
      pendingRow({ id: 'real-work', created_at: '2020-01-02T00:00:00Z' }),
    ],
  });

  const dispatched = await runWorkerWith(sb);

  assert.ok(dispatched >= 1, 'the archived head must not block the queue');
  assert.equal(sb._store.dev_build_requests.find((r) => r.id === 'real-work').status, 'building');
  assert.equal(sb._store.dev_build_requests.find((r) => r.id === 'archived-head').status, 'pending',
    'an archived row is still never built');
});

test('a failing query fails the tick loudly instead of reading as an empty queue', async () => {
  const sb = makeSelfHealSupabase({ dev_build_requests: [pendingRow()] });
  const realFrom = sb.from;
  sb.from = (name) => {
    const q = realFrom(name);
    const realThen = q.then;
    q.then = (resolve) => realThen.call(q, () => resolve({ data: null, error: { message: 'connection reset' } }));
    return q;
  };

  await assert.rejects(() => runWorkerWith(sb), /connection reset/);
  const st = workerStatus();
  assert.match(st.lastError.message, /connection reset/);
  assert.ok(st.consecutiveErrors >= 1, 'the error survives in the heartbeat, not just a log line');
});

test('the heartbeat names the rows holding the slots, with their age', async () => {
  // Exactly today's failure: merged PRs whose callbacks never arrived sat in
  // `merging` and consumed every slot. The number alone was not enough — the
  // route has to say WHICH rows and for how long.
  // Inside its stage TTL, so it legitimately still holds the slot (past it, the
  // stage-timeout sweep would have retired it — see below).
  const held = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const sb = makeSelfHealSupabase({
    dev_build_requests: [
      { id: 'ghost', status: 'merging', archived: false, pr_number: 110, title: 'green, waiting on auto-merge', history: [], entered_at: held, updated_at: held, created_at: held },
      pendingRow(),
      pendingRow({ id: 'p2' }),
    ],
  });

  await runWorkerWith(sb);

  const st = workerStatus();
  assert.equal(st.gates.inflight, 1, 'the in-flight row is counted');
  assert.ok(st.inflightRows.some((r) => r.id === 'ghost' && r.heldForMinutes >= 35 && r.ttlMinutes > 0),
    'the slot-holder is named with its age and the limit it is measured against');
  assert.ok(st.gates.pending >= 2, 'the queue depth is visible next to it');
});

test('parked and superseded rows do not spend the daily build budget', async () => {
  // A double-capture that parks seven near-duplicates must not consume a day of
  // build headroom for work that was never built.
  const now = new Date().toISOString();
  const sb = makeSelfHealSupabase({
    dev_build_requests: [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, status: 'superseded', archived: true, history: [], created_at: now, updated_at: now })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, status: 'needs_attention', archived: false, history: [], created_at: now, updated_at: now })),
      pendingRow(),
    ],
  });

  await runWorkerWith(sb);

  assert.equal(workerStatus().gates.today, 1, 'only the row that can actually build counts');
  assert.equal(sb._store.dev_build_requests.find((r) => r.id === 'p1').status, 'building');
});

// ─── Stage timeouts: no state may be permanent ───────────────────────────────

test('a row past its stage TTL is retired, with the reason written into it', async () => {
  const stale = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{
      id: 'ghost', status: 'merging', archived: false, pr_number: 124, title: 'held the only slot',
      history: [], entered_at: stale, updated_at: stale, created_at: stale,
    }],
  });

  const { retired } = await sweepStageTimeouts(sb);

  const row = sb._store.dev_build_requests[0];
  assert.equal(retired, 1);
  assert.equal(row.status, 'needs_attention', 'the slot must come back');
  assert.match(row.error, /stage timeout: held \d+m in merging/);
  assert.match(row.error, /PR #124 never reported a terminal state/);
  assert.ok(row.timed_out_at, 'the timeout marker is what stops the reconciler re-arming it');
  assert.equal(row.failure_class, 'terminal', 'a stage timeout is never auto-retried');
  assert.equal(sb._store.pipeline_alerts.length, 1, 'one visible alert per stuck row');
});

test('a row still inside its stage TTL is left alone', async () => {
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{
      id: 'fresh', status: 'deploying', archived: false, history: [],
      entered_at: recent, updated_at: recent, created_at: recent,
    }],
  });

  const { retired } = await sweepStageTimeouts(sb);

  assert.equal(retired, 0);
  assert.equal(sb._store.dev_build_requests[0].status, 'deploying');
});

test('rows predating the stage clock fall back to updated_at rather than never ageing out', async () => {
  const stale = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
  const sb = makeSelfHealSupabase({
    dev_build_requests: [{
      id: 'old', status: 'deploying', archived: false, history: [],
      entered_at: null, updated_at: stale, created_at: stale,
    }],
  });

  assert.equal((await sweepStageTimeouts(sb)).retired, 1);
});

test('the timed-out slot is reused by the same tick, not the next one', async () => {
  // The whole point: a stuck row must not cost a dispatch cycle on its way out.
  const stale = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const sb = makeSelfHealSupabase({
    dev_build_requests: [
      { id: 'ghost', status: 'deploying', archived: false, history: [], entered_at: stale, updated_at: stale, created_at: stale },
      { id: 'ghost2', status: 'merging', archived: false, history: [], entered_at: stale, updated_at: stale, created_at: stale },
      pendingRow(),
    ],
  });

  const dispatched = await runWorkerWith(sb);

  assert.equal(dispatched, 1, 'the freed slot is filled immediately');
  assert.equal(sb._store.dev_build_requests.find((r) => r.id === 'p1').status, 'building');
  assert.equal(workerStatus().lastSweep.retired, 2);
});

test('a status change stamps the stage clock; the retry pass does not', async () => {
  const sb = makeSelfHealSupabase({ dev_build_requests: [pendingRow({ entered_at: null })] });
  await runWorkerWith(sb);
  const row = sb._store.dev_build_requests[0];
  assert.equal(row.status, 'building');
  assert.ok(row.entered_at, 'entering `building` starts that stage clock');
});

// ─── Watchdog: the stall corrects itself and says that it did ────────────────

const NOW_MS = Date.parse('2026-08-05T18:00:00Z');
const ago = (ms) => new Date(NOW_MS - ms).toISOString();

/** A workerStatus() shape, healthy unless told otherwise. */
const statusOf = (over = {}) => () => ({
  bootedAt: ago(3600_000),
  lastTickStartedAt: ago(10_000),
  lastTickFinishedAt: ago(9_000),
  running: false,
  consecutiveErrors: 0,
  starved: false,
  maxConcurrent: 1,
  gates: { inflight: 0, pending: 0, dispatched: 0 },
  inflightRows: [],
  lastError: null,
  ...over,
});

test('watchdog leaves a healthy dispatcher alone', async () => {
  const sb = makeSelfHealSupabase();
  let kicked = 0;
  const r = await runWorkerWatchdog({ supabase: sb, kick: () => { kicked += 1; }, status: statusOf(), now: NOW_MS });

  assert.equal(r.healthy, true);
  assert.equal(kicked, 0, 'a healthy tick is never restarted');
  assert.equal(sb._store.pipeline_alerts.length, 0, 'and never alerted on');
});

test('watchdog restarts a dispatcher that stopped ticking', async () => {
  const sb = makeSelfHealSupabase();
  let kicked = 0; let rearmed = 0;
  const r = await runWorkerWatchdog({
    supabase: sb,
    kick: () => { kicked += 1; },
    restartTimer: () => { rearmed += 1; },
    status: statusOf({ lastTickFinishedAt: ago(20 * 60_000), lastTickStartedAt: ago(20 * 60_000) }),
    now: NOW_MS,
  });

  assert.equal(r.healthy, false);
  assert.match(r.reasons[0], /no completed tick for \d+s/);
  assert.equal(rearmed, 1, 'the interval is re-armed — a dead timer is not fixed by one tick');
  assert.equal(kicked, 1, 'and a tick runs now, not in 60s');
  assert.equal(sb._store.pipeline_alerts[0].kind, 'worker_stall', 'the self-restart is visible, not silent');
});

test('watchdog fires on the exact 2026-08-05 shape: pending work, free slot, no dispatch', async () => {
  const sb = makeSelfHealSupabase();
  const starved = statusOf({ starved: true, gates: { inflight: 0, pending: 29, dispatched: 0 } });
  let kicked = 0;

  // One starved tick is not a stall: a row can arrive a millisecond after the
  // queue was read. The watchdog waits for it to persist.
  const first = await runWorkerWatchdog({ supabase: sb, kick: () => { kicked += 1; }, status: starved, now: NOW_MS });
  assert.equal(first.healthy, true, 'a single starved tick is tolerated');
  assert.equal(kicked, 0);

  const later = await runWorkerWatchdog({ supabase: sb, kick: () => { kicked += 1; }, status: starved, now: NOW_MS + 3 * 60_000 });
  assert.equal(later.healthy, false);
  assert.match(later.reasons[0], /29 pending with 1 free slot\(s\) and nothing dispatched/);
  assert.equal(kicked, 1);
  assert.equal(sb._store.pipeline_alerts.filter((a) => !a.resolved_at).length, 1);
});

test('a continuing stall raises ONE alert, and recovery closes it', async () => {
  const sb = makeSelfHealSupabase();
  const stalled = statusOf({ lastTickFinishedAt: ago(30 * 60_000), lastTickStartedAt: ago(30 * 60_000) });

  await runWorkerWatchdog({ supabase: sb, kick: () => {}, status: stalled, now: NOW_MS });
  await runWorkerWatchdog({ supabase: sb, kick: () => {}, status: stalled, now: NOW_MS + 60_000 });
  assert.equal(sb._store.pipeline_alerts.length, 1, 'a stall that lasts an hour is one alert, not sixty');

  await runWorkerWatchdog({ supabase: sb, kick: () => {}, status: statusOf(), now: NOW_MS + 120_000 });
  assert.ok(sb._store.pipeline_alerts[0].resolved_at,
    'an open worker_stall must always mean "right now"');
});

test('watchdog fires when every tick throws', async () => {
  const sb = makeSelfHealSupabase();
  const r = await runWorkerWatchdog({
    supabase: sb,
    kick: () => {},
    status: statusOf({ consecutiveErrors: 4, lastError: { message: 'connection reset' } }),
    now: NOW_MS,
  });

  assert.equal(r.healthy, false);
  assert.match(r.reasons[0], /4 consecutive tick failures: connection reset/);
});
