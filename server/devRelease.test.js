// Unit tests for the build train's release bookkeeping. No network: the two
// GitHub reads go through global fetch, which each test that needs them stubs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDevRequestIds,
  parsePrNumbers,
  buildChangelog,
  nextVersion,
  upsertRelease,
  startRelease,
  completeRelease,
} from './devRelease.js';

const ID_A = '758e028b-84b3-4f41-b331-4eda57dc6d24';
const ID_B = '08f6ba57-1112-4978-9e41-9dd813e4f9c6';

// ─── Pure parsing ────────────────────────────────────────────────────────────

test('parseDevRequestIds picks up trailers, de-duplicates, lowercases', () => {
  const commits = [
    { sha: 'a', message: `auto: one\n\nDev-Request-Id: ${ID_A}` },
    { sha: 'b', message: `auto: two\n\nDev-Request-Id: ${ID_B.toUpperCase()}` },
    { sha: 'c', message: `auto: again\n\nDev-Request-Id: ${ID_A}` },
    { sha: 'd', message: 'chore: no trailer here' },
  ];
  assert.deepEqual(parseDevRequestIds(commits), [ID_A, ID_B]);
});

test('parseDevRequestIds ignores a trailer-looking line that is not a uuid', () => {
  assert.deepEqual(parseDevRequestIds([{ message: 'x\n\nDev-Request-Id: not-a-uuid' }]), []);
});

test('parsePrNumbers reads the squash subject only, never the body', () => {
  const commits = [
    { message: 'auto: fix the thing (#42)\n\nbody mentioning (#99)' },
    { message: 'chore: something (#7)' },
    { message: 'docs: relates to #123 but is not a squash merge' },
    { message: 'auto: fix the thing (#42)' },
  ];
  assert.deepEqual(parsePrNumbers(commits), [42, 7]);
});

test('buildChangelog reads as "Build N — M changes" with a line per change', () => {
  const text = buildChangelog(12, [
    { title: 'Fix voice timeout', pr_number: 62 },
    { title: 'Move the dev toggle', pr_number: 74 },
  ]);
  assert.equal(text.split('\n')[0], 'Build 12 — 2 changes');
  assert.ok(text.includes('- Fix voice timeout (#62)'));
  assert.ok(text.includes('- Move the dev toggle (#74)'));
});

test('buildChangelog stays a sentence when the batch is one or empty', () => {
  assert.equal(buildChangelog(3, [{ title: 'Only one', pr_number: 1 }]).split('\n')[0], 'Build 3 — 1 change');
  assert.equal(buildChangelog(4, []), 'Build 4 — 0 changes');
});

test('nextVersion continues from the highest existing version', () => {
  assert.equal(nextVersion([]), 1);
  assert.equal(nextVersion([{ version: 1 }, { version: 7 }, { version: 3 }]), 8);
});

// ─── Supabase double ─────────────────────────────────────────────────────────

function makeSupabase(seed = {}) {
  const store = {
    releases: seed.releases ?? [],
    dev_build_requests: seed.dev_build_requests ?? [],
    changes: seed.changes ?? [],
  };
  let seq = 0;

  const table = (name) => {
    const preds = [];
    let mode = 'select';
    let patch = null;
    let insertRows = null;
    let single = false;
    let limitN = null;
    let orderCol = null;
    let orderAsc = true;

    const self = {
      // select() never changes the mode: PostgREST's insert().select() asks the
      // insert to RETURN rows, it does not turn the call into a query.
      select() { return self; },
      insert(rows) { mode = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return self; },
      update(p) { mode = 'update'; patch = p; return self; },
      eq(c, v) { preds.push((r) => r[c] === v); return self; },
      in(c, vals) { preds.push((r) => vals.includes(r[c])); return self; },
      not(c, op, v) {
        if (op === 'is' && v === null) preds.push((r) => r[c] !== null && r[c] !== undefined);
        return self;
      },
      order(c, opt) { orderCol = c; orderAsc = !opt || opt.ascending !== false; return self; },
      limit(n) { limitN = n; return self; },
      single() { single = true; return self; },
      then(resolve) {
        const matching = () => {
          let out = (store[name] || []).filter((r) => preds.every((f) => f(r)));
          if (orderCol) {
            out = [...out].sort((a, b) => {
              const x = a[orderCol], y = b[orderCol];
              if (x === y) return 0;
              return (x > y ? 1 : -1) * (orderAsc ? 1 : -1);
            });
          }
          if (limitN != null) out = out.slice(0, limitN);
          return out;
        };

        if (mode === 'insert') {
          const created = insertRows.map((row) => {
            seq += 1;
            const full = { id: `${name}-${seq}`, ...row };
            store[name].push(full);
            return full;
          });
          const data = single ? created[0] : created;
          return Promise.resolve({ data, error: null }).then(resolve);
        }

        if (mode === 'update') {
          const targets = matching();
          for (const r of targets) Object.assign(r, patch);
          return Promise.resolve({ data: targets, error: null }).then(resolve);
        }

        const out = matching();
        if (single) return Promise.resolve({ data: out[0] || null, error: out[0] ? null : { message: 'not found' } }).then(resolve);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return self;
  };

  return { from: table, _store: store };
}

/** Stub global fetch for the two GitHub reads devRelease makes. */
function stubGitHub(commitsByCompare) {
  const original = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (String(url).includes('/compare/')) {
        return { commits: commitsByCompare.map((c) => ({ sha: c.sha, commit: { message: c.message } })) };
      }
      const head = commitsByCompare[commitsByCompare.length - 1];
      return { sha: head.sha, commit: { message: head.message } };
    },
  });
  return () => { globalThis.fetch = original; };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

test('upsertRelease is idempotent on the Actions run id', async () => {
  const supabase = makeSupabase();
  const first = await upsertRelease(supabase, { runId: '999', runNumber: 4, commitSha: 'head1' });
  const second = await upsertRelease(supabase, { runId: '999', runNumber: 4, commitSha: 'head1' });

  assert.equal(first.id, second.id, 'a retried callback must not fork the release row');
  assert.equal(supabase._store.releases.length, 1);
  assert.equal(first.version, 1);
  assert.equal(first.status, 'building');
});

test('startRelease groups every carried request and writes the changelog', async () => {
  const restore = stubGitHub([
    { sha: 'c1', message: `auto: fix voice\n\nDev-Request-Id: ${ID_A}` },
    { sha: 'c2', message: 'chore(pipeline): hand-made change (#73)' },
  ]);
  const supabase = makeSupabase({
    releases: [{ id: 'rel-old', version: 4, commit_sha: 'base1', run_id: '111', status: 'live' }],
    dev_build_requests: [
      { id: ID_A, title: 'Fix voice', pr_number: 62, status: 'deploying', release_id: null },
      { id: ID_B, title: 'Hand-made change', pr_number: 73, status: 'deploying', release_id: null },
      { id: 'unrelated', title: 'Not in this build', pr_number: 5, status: 'deploying', release_id: null },
    ],
  });

  const release = await startRelease(supabase, { runId: '222', runNumber: 9, commitSha: 'head2' });
  restore();

  assert.equal(release.version, 5, 'versions continue from the previous release');
  assert.equal(release.change_count, 2);
  assert.equal(release.changelog.split('\n')[0], 'Build 5 — 2 changes');

  const linked = supabase._store.dev_build_requests.filter((r) => r.release_id === release.id).map((r) => r.id);
  assert.deepEqual(linked.sort(), [ID_B, ID_A].sort());
  assert.equal(
    supabase._store.dev_build_requests.find((r) => r.id === 'unrelated').release_id,
    null,
    'a request outside the diff must not be swept into the build',
  );

  // `changes` has been empty since migration 018 — this is what finally fills it.
  assert.equal(supabase._store.changes.length, 2);
  assert.equal(supabase._store.changes[0].dev_request_id, ID_A);
});

test('completeRelease settles every carried request, not just the one that triggered it', async () => {
  const restore = stubGitHub([
    { sha: 'c1', message: `auto: a\n\nDev-Request-Id: ${ID_A}` },
    { sha: 'c2', message: `auto: b\n\nDev-Request-Id: ${ID_B}` },
  ]);
  const supabase = makeSupabase({
    releases: [{ id: 'rel-old', version: 1, commit_sha: 'base1', run_id: '111', status: 'live' }],
    dev_build_requests: [
      { id: ID_A, title: 'A', pr_number: 1, status: 'deploying', release_id: null },
      { id: ID_B, title: 'B', pr_number: 2, status: 'deploying', release_id: null },
    ],
  });

  const release = await completeRelease(supabase, { runId: '333', commitSha: 'head3', status: 'live' });
  restore();

  assert.equal(release.status, 'live');
  assert.equal(supabase._store.releases.find((r) => r.run_id === '333').status, 'live');
  for (const r of supabase._store.dev_build_requests) {
    assert.equal(r.status, 'deployed', `${r.id} should be deployed by the release that carried it`);
    assert.equal(r.deploy_status, 'ok');
  }
  assert.ok(supabase._store.changes.every((c) => c.status === 'deployed'));
});

test('completeRelease with a failed build fails the batch instead of stranding it', async () => {
  const restore = stubGitHub([{ sha: 'c1', message: `auto: a\n\nDev-Request-Id: ${ID_A}` }]);
  const supabase = makeSupabase({
    releases: [{ id: 'rel-old', version: 1, commit_sha: 'base1', run_id: '111', status: 'live' }],
    dev_build_requests: [{ id: ID_A, title: 'A', pr_number: 1, status: 'deploying', release_id: null }],
  });

  await completeRelease(supabase, { runId: '444', commitSha: 'head4', status: 'failed', error: 'EAS build failed' });
  restore();

  const row = supabase._store.dev_build_requests[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.deploy_status, 'failed');
  assert.match(row.error, /EAS build failed/);
  assert.equal(supabase._store.releases.find((r) => r.run_id === '444').status, 'failed');
});

test('completeRelease works when start never landed (dropped callback)', async () => {
  const restore = stubGitHub([{ sha: 'c1', message: `auto: a\n\nDev-Request-Id: ${ID_A}` }]);
  const supabase = makeSupabase({
    dev_build_requests: [{ id: ID_A, title: 'A', pr_number: 1, status: 'deploying', release_id: null }],
  });

  const release = await completeRelease(supabase, { runId: '555', commitSha: 'head5', status: 'live' });
  restore();

  assert.equal(release.version, 1, 'the release is created on the way out if it was never opened');
  assert.equal(supabase._store.dev_build_requests[0].status, 'deployed');
});

test('a request already deployed is not rewritten by a later release', async () => {
  const restore = stubGitHub([{ sha: 'c1', message: `auto: a\n\nDev-Request-Id: ${ID_A}` }]);
  const supabase = makeSupabase({
    dev_build_requests: [{ id: ID_A, title: 'A', pr_number: 1, status: 'deployed', deploy_status: 'ok', release_id: null }],
  });

  await completeRelease(supabase, { runId: '666', commitSha: 'head6', status: 'failed', error: 'later build broke' });
  restore();

  assert.equal(supabase._store.dev_build_requests[0].status, 'deployed');
  assert.equal(supabase._store.dev_build_requests[0].error, undefined);
});
