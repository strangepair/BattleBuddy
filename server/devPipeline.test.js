// Unit tests for the Developer-mode pipeline's pure logic. No network / no
// external deps (devPipeline imports only node:crypto), so this runs green even
// where the full server dependency tree can't be installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, looksForbidden, patchForEvent, isPipelineEnabled, collapseNearDuplicates, generateProductRequests, insertRequests } from './devPipeline.js';

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
