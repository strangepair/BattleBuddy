// Unit tests for the reconciler. deriveState is pure, so most of this file is
// straight table-testing of the derivation; the tick test stubs global fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestIdForPr,
  checksVerdict,
  deriveState,
  stageForStatus,
  changeStatusFor,
  runReconcileTick,
  reconcileStatus,
  RECONCILABLE,
} from './devReconcile.js';

const ID = '758e028b-84b3-4f41-b331-4eda57dc6d24';
const NOW = Date.parse('2026-08-03T20:00:00Z');
const OLD = '2026-08-01T10:00:00Z';

const openPr = (over = {}) => ({
  number: 12, html_url: 'https://x/12', state: 'open', merged_at: null,
  head: { ref: `auto/dev-${ID}`, sha: 'headsha' }, ...over,
});
const mergedPr = (over = {}) => ({
  number: 62, html_url: 'https://x/62', state: 'closed',
  merged_at: '2026-08-01T19:28:00Z', merge_commit_sha: 'merge62',
  head: { ref: `auto/dev-${ID}`, sha: 'headsha' }, ...over,
});
const row = (over = {}) => ({ id: ID, status: 'building', created_at: OLD, ...over });

// ─── Mapping ─────────────────────────────────────────────────────────────────

test('requestIdForPr reads the branch first, then the commit trailer', () => {
  assert.equal(requestIdForPr(openPr()), ID);
  assert.equal(
    requestIdForPr({ head: { ref: 'feat/hand-made' } }, ['chore: x\n\nDev-Request-Id: ' + ID]),
    ID,
  );
  assert.equal(requestIdForPr({ head: { ref: 'feat/hand-made' } }, ['chore: x']), null);
});

test('checksVerdict collapses a check-run list', () => {
  assert.equal(checksVerdict([]), null);
  assert.equal(checksVerdict([{ status: 'in_progress' }]), 'running');
  assert.equal(checksVerdict([{ status: 'completed', conclusion: 'success' }]), 'passed');
  assert.equal(
    checksVerdict([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]),
    'failed',
  );
  // A failure anywhere wins even while other checks are still running.
  assert.equal(
    checksVerdict([{ status: 'in_progress' }, { status: 'completed', conclusion: 'failure' }]),
    'failed',
  );
  assert.equal(checksVerdict([{ status: 'completed', conclusion: 'skipped' }]), 'passed');
});

// ─── Open / closed ───────────────────────────────────────────────────────────

test('an open PR derives in_review, merging or failed from its checks', () => {
  assert.equal(deriveState({ row: row(), pr: openPr(), checks: 'running', now: NOW }).status, 'in_review');
  assert.equal(deriveState({ row: row(), pr: openPr(), checks: 'passed', now: NOW }).status, 'merging');
  const failed = deriveState({ row: row(), pr: openPr(), checks: 'failed', now: NOW });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.checks_status, 'failed');
});

test('a closed, never-merged PR is superseded', () => {
  // PR #95 (closed in favour of #96 on the same branch) is the canonical case:
  // before this state existed the row sat at in_review forever.
  const patch = deriveState({
    row: row({ status: 'in_review' }),
    pr: mergedPr({ merged_at: null, merge_commit_sha: null }),
    now: NOW,
  });
  assert.equal(patch.status, 'superseded');
});

// ─── Merged ──────────────────────────────────────────────────────────────────

test('merged + a successful Deploy run is deployed', () => {
  const patch = deriveState({
    row: row({ status: 'deploying' }),
    pr: mergedPr(),
    deploy: { status: 'completed', conclusion: 'success' },
    now: NOW,
  });
  assert.equal(patch.status, 'deployed');
  assert.equal(patch.deploy_status, 'ok');
});

test('merged + a Deploy run still going is deploying, not guessed', () => {
  const patch = deriveState({
    row: row({ status: 'in_review' }),
    pr: mergedPr(),
    deploy: { status: 'in_progress', conclusion: null },
    now: NOW,
  });
  assert.equal(patch.status, 'deploying');
});

test('merged with no Deploy run at all is deploying, not failed', () => {
  const patch = deriveState({ row: row({ status: 'in_review' }), pr: mergedPr(), deploy: null, now: NOW });
  assert.equal(patch.status, 'deploying');
});

test('a later successful main deploy supersedes an earlier failed one', () => {
  // THE four stale rows. deploy.yml deploys main wholesale (railway up from a
  // fresh checkout, psql over every migration), so once a later deploy of main
  // succeeds the earlier code is live no matter what its own run concluded.
  // PRs #59 and #73 failed their own deploy on the old non-idempotent
  // migration — after the real work had already succeeded.
  const patch = deriveState({
    row: row({ status: 'failed', deploy_status: 'failed', error: 'deploy failed' }),
    pr: mergedPr(),
    deploy: { status: 'completed', conclusion: 'failure' },
    lastGoodDeploy: '2026-08-03T20:00:34Z',
    now: NOW,
  });
  assert.equal(patch.status, 'deployed');
  assert.equal(patch.deploy_status, 'ok');
  assert.equal(patch.error, null, 'the stale error text has to be cleared too');
});

test('a failed deploy with no later success stays failed', () => {
  const patch = deriveState({
    row: row({ status: 'deploying' }),
    pr: mergedPr({ merged_at: '2026-08-03T19:00:00Z' }),
    deploy: { status: 'completed', conclusion: 'failure' },
    lastGoodDeploy: '2026-08-03T18:00:00Z',   // BEFORE the merge — carries nothing
    now: NOW,
  });
  assert.equal(patch.status, 'failed');
  assert.equal(patch.deploy_status, 'failed');
});

// ─── The build train ─────────────────────────────────────────────────────────

test('a merged mobile change is not deployed until a release carries it', () => {
  const base = {
    row: row({ status: 'deploying' }),
    pr: mergedPr(),
    deploy: { status: 'completed', conclusion: 'success' },
    touchesMobile: true,
    trainEpoch: '2026-08-01T00:00:00Z',   // merged after the train existed
    now: NOW,
  };
  assert.equal(deriveState({ ...base, release: null }).status, undefined,
    'no release yet: it stays deploying, and "deploying" is already the row status so nothing changes');
  assert.equal(deriveState({ ...base, row: row({ status: 'in_review' }), release: null }).status, 'deploying');
  assert.equal(deriveState({ ...base, release: { status: 'live' } }).status, 'deployed');
  assert.equal(deriveState({ ...base, release: { status: 'failed' } }).status, 'failed');
});

test('a merged server-only change does not wait for the build train', () => {
  const patch = deriveState({
    row: row({ status: 'deploying' }),
    pr: mergedPr(),
    deploy: { status: 'completed', conclusion: 'success' },
    touchesMobile: false,
    now: NOW,
  });
  assert.equal(patch.status, 'deployed');
});

// ─── Precedence: local-only states ───────────────────────────────────────────

test('with no PR, local-only states survive untouched', () => {
  assert.deepEqual(deriveState({ row: row({ status: 'pending' }), pr: null, now: NOW }), {});
  assert.deepEqual(
    deriveState({ row: row({ status: 'needs_attention', error: 'scope fence' }), pr: null, now: NOW }),
    {},
    'a scope-fence block is a decision GitHub never saw — nothing here may overwrite it',
  );
});

test('a build with no branch or PR after the grace period is an orphan', () => {
  const stale = deriveState({
    row: row({ status: 'building', created_at: '2026-08-03T18:00:00Z' }),
    pr: null,
    now: NOW,
  });
  assert.equal(stale.status, 'needs_attention');
  assert.match(stale.error, /never got far enough to push/);

  const fresh = deriveState({
    row: row({ status: 'building', created_at: '2026-08-03T19:55:00Z' }),
    pr: null,
    now: NOW,
  });
  assert.deepEqual(fresh, {}, 'a build dispatched five minutes ago is not an orphan');
});

test('deriveState patches only the difference', () => {
  const settled = row({
    status: 'deployed', deploy_status: 'ok', error: null, checks_status: 'passed',
    pr_number: 62, pr_url: 'https://x/62', branch: `auto/dev-${ID}`,
  });
  assert.deepEqual(
    deriveState({
      row: settled, pr: mergedPr(), deploy: { status: 'completed', conclusion: 'success' }, now: NOW,
    }),
    {},
    'an already-correct row must produce no patch, or every tick spams history',
  );
});

// ─── Projections ─────────────────────────────────────────────────────────────

test('work item stage and change status follow the request', () => {
  assert.equal(stageForStatus('deployed'), 'live');
  assert.equal(stageForStatus('superseded'), 'archived');
  assert.equal(stageForStatus('in_review'), 'verifying');
  assert.equal(stageForStatus('failed'), null, 'a failure leaves the stage where it was');
  assert.equal(changeStatusFor('deployed'), 'deployed');
  assert.equal(changeStatusFor('superseded'), 'superseded');
});

test('terminal states are not re-derived every tick', () => {
  assert.ok(!RECONCILABLE.includes('deployed'));
  assert.ok(!RECONCILABLE.includes('duplicate'));
  assert.ok(RECONCILABLE.includes('needs_attention'));
});

// ─── One tick, end to end ────────────────────────────────────────────────────

function makeSupabase(seed = {}) {
  const store = {
    dev_build_requests: seed.dev_build_requests ?? [],
    work_items: seed.work_items ?? [],
    changes: seed.changes ?? [],
    releases: seed.releases ?? [],
    pipeline_events: seed.pipeline_events ?? [],
  };
  let seq = 0;

  const table = (name) => {
    const preds = [];
    let mode = 'select', patch = null, insertRows = null, single = false, limitN = null;
    const self = {
      select() { return self; },
      insert(rows) { mode = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return self; },
      update(p) { mode = 'update'; patch = p; return self; },
      eq(c, v) { preds.push((r) => r[c] === v); return self; },
      in(c, vals) { preds.push((r) => vals.includes(r[c])); return self; },
      not(c, op, v) { if (op === 'is' && v === null) preds.push((r) => r[c] !== null && r[c] !== undefined); return self; },
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
          const created = insertRows.map((r) => {
            seq += 1;
            const full = { id: `${name}-${seq}`, ...r };
            store[name].push(full);
            return full;
          });
          return Promise.resolve({ data: single ? created[0] : created, error: null }).then(resolve);
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

function stubGitHub({ pulls, deployRuns, files = [], checkRuns = [] }) {
  const original = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  globalThis.fetch = async (url) => {
    const u = String(url);
    let body;
    if (u.includes('/pulls?')) body = pulls;
    else if (u.includes('/actions/workflows/deploy.yml/runs')) body = { workflow_runs: deployRuns };
    else if (u.includes('/files')) body = files;
    else if (u.includes('/check-runs')) body = { check_runs: checkRuns };
    else if (/\/pulls\/\d+$/.test(u)) body = pulls.find((p) => u.endsWith(`/${p.number}`)) || null;
    else body = {};
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  };
  return () => { globalThis.fetch = original; };
}

test('one tick repairs a stale row, projects it, and adopts an untracked PR', async () => {
  const pulls = [
    // The drifted row: merged, its own deploy failed, but main deployed fine later.
    { number: 62, html_url: 'https://x/62', state: 'closed', merged_at: '2026-08-01T19:28:00Z',
      merge_commit_sha: 'merge62', updated_at: '2026-08-01T19:28:00Z', created_at: OLD,
      head: { ref: `auto/dev-${ID}`, sha: 'h62' }, title: 'Fix voice timeout', labels: [] },
    // A hand-made PR nobody submitted through the app.
    { number: 112, html_url: 'https://x/112', state: 'open', merged_at: null,
      updated_at: '2026-08-03T19:50:00Z', created_at: '2026-08-03T19:00:00Z',
      head: { ref: 'feat/build-train-stage-1', sha: 'h112' },
      title: 'feat(pipeline): build train', body: 'stage 1', labels: [] },
  ];
  const deployRuns = [
    { head_sha: 'merge62', status: 'completed', conclusion: 'failure', head_branch: 'main',
      head_commit: { timestamp: '2026-08-01T19:30:00Z' } },
    { head_sha: 'later', status: 'completed', conclusion: 'success', head_branch: 'main',
      head_commit: { timestamp: '2026-08-03T20:00:34Z' } },
  ];
  const restore = stubGitHub({ pulls, deployRuns });

  const supabase = makeSupabase({
    dev_build_requests: [{
      id: ID, status: 'failed', deploy_status: 'failed', error: 'deploy failed',
      title: 'Fix voice timeout', target: 'agent', created_at: OLD,
      pr_number: 62, branch: `auto/dev-${ID}`, history: [],
    }],
  });

  const transitions = [];
  const result = await runReconcileTick({ supabase, onTransition: (t) => transitions.push(t) });
  restore();

  const repaired = supabase._store.dev_build_requests.find((r) => r.id === ID);
  assert.equal(repaired.status, 'deployed', 'the stale row must flip to its true state');
  assert.equal(repaired.deploy_status, 'ok');
  assert.equal(repaired.error, null);
  assert.ok(repaired.reconciled_at, 'the row records that it was checked');
  assert.equal(repaired.history.at(-1).note, 'reconciled from GitHub');

  // The projection: `changes` was empty because nothing wrote it.
  const change = supabase._store.changes.find((c) => c.dev_request_id === ID);
  assert.ok(change, 'a changes row is written for the request');
  assert.equal(change.status, 'deployed');
  const wi = supabase._store.work_items[0];
  assert.ok(wi, 'a work item is created for a request that had none');
  assert.equal(repaired.work_item_id, wi.id);

  assert.deepEqual(transitions.map((t) => [t.from, t.to]), [['failed', 'deployed']]);
  assert.equal(result.patched, 1);

  // Adoption: the hand-made PR gets a row so every change is tracked.
  const adopted = supabase._store.dev_build_requests.find((r) => r.pr_number === 112);
  assert.ok(adopted, 'an untracked PR is adopted');
  assert.equal(adopted.source, 'github');
  assert.equal(adopted.status, 'in_review');
  assert.equal(result.adopted, 1);
});

test('a tick with nothing to say writes no history', async () => {
  const pulls = [{
    number: 62, html_url: 'https://x/62', state: 'closed', merged_at: '2026-08-01T19:28:00Z',
    merge_commit_sha: 'merge62', updated_at: '2026-08-01T19:28:00Z', created_at: OLD,
    head: { ref: `auto/dev-${ID}`, sha: 'h62' }, title: 'x', labels: [],
  }];
  const restore = stubGitHub({
    pulls,
    deployRuns: [{ head_sha: 'merge62', status: 'in_progress', conclusion: null, head_branch: 'main' }],
  });
  const supabase = makeSupabase({
    dev_build_requests: [{
      id: ID, status: 'deploying', title: 'x', created_at: OLD,
      pr_number: 62, pr_url: 'https://x/62', branch: `auto/dev-${ID}`,
      checks_status: 'passed', history: [],
    }],
  });

  const result = await runReconcileTick({ supabase });
  restore();

  assert.equal(result.patched, 0);
  assert.deepEqual(supabase._store.dev_build_requests[0].history, [], 'no transition, no history entry');
  assert.ok(supabase._store.dev_build_requests[0].reconciled_at, 'but we still record that we looked');
});

test('the tick no-ops without a GitHub token', async () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const result = await runReconcileTick({ supabase: makeSupabase() });
  if (saved) process.env.GITHUB_TOKEN = saved;
  assert.deepEqual(result, { checked: 0, patched: 0, adopted: 0 });
});

// ─── Stage 2a: the three defects the live pipeline exposed ───────────────────

test('a mobile change merged BEFORE the train existed is not stranded', () => {
  // PRs #93 and #83 sat at `deploying` forever: they touch mobile/, they merged
  // before mobile-release.yml existed, and so no release will ever carry them.
  // Gating those on a release reintroduces the exact drift this module removes.
  const base = {
    row: row({ status: 'deploying' }),
    pr: mergedPr({ merged_at: '2026-08-03T00:41:49Z' }),
    deploy: { status: 'completed', conclusion: 'success' },
    touchesMobile: true,
    release: null,
    now: NOW,
  };
  assert.equal(
    deriveState({ ...base, trainEpoch: '2026-08-03T20:28:58Z' }).status,
    'deployed',
    'merged before the train epoch -> deploy.yml built it, so it is shipped',
  );
  assert.equal(
    deriveState({ ...base, trainEpoch: null }).status,
    'deployed',
    'no train at all -> nothing is gated',
  );
  assert.equal(
    deriveState({ ...base, row: row({ status: 'in_review' }), trainEpoch: '2026-08-01T00:00:00Z' }).status,
    'deploying',
    'merged after the train epoch -> it really does have to ride a build',
  );
});

test('the reconciler never downgrades a breaker escalation to failed', () => {
  // needs_attention means the circuit breaker escalated after N failures sharing
  // a signature. That is strictly more information than "CI is red", which is
  // all this module can see. Without arbitration the two paths overwrite each
  // other every 60 s and the alert is buried.
  const patch = deriveState({
    row: row({ status: 'needs_attention', error: 'breaker: 3 failures', pr_number: 12, pr_url: 'https://x/12', branch: `auto/dev-${ID}` }),
    pr: openPr(),
    checks: 'failed',
    now: NOW,
  });
  assert.equal(patch.status, undefined, 'status is left alone');
  assert.equal(patch.error, undefined, 'and so is the breaker explanation');
  assert.equal(patch.checks_status, 'failed', 'but GitHub facts still land');
});

test('GitHub still moves a needs_attention row when it knows something better', () => {
  const merged = deriveState({
    row: row({ status: 'needs_attention', error: 'breaker' }),
    pr: mergedPr(),
    deploy: { status: 'completed', conclusion: 'success' },
    now: NOW,
  });
  assert.equal(merged.status, 'deployed', 'merged and deployed beats a stale escalation');

  const closed = deriveState({
    row: row({ status: 'needs_attention', error: 'breaker' }),
    pr: mergedPr({ merged_at: null, merge_commit_sha: null }),
    now: NOW,
  });
  assert.equal(closed.status, 'superseded');
});

test('one throwing row cannot stall the tick', async () => {
  // The stall: no per-row try/catch meant a single bad row aborted the tick, and
  // since earlier rows had already advanced `reconciled_at`, every later tick
  // restarted at the same bad row and died there. Forever.
  const pulls = [
    { number: 62, html_url: 'https://x/62', state: 'closed', merged_at: '2026-08-01T19:28:00Z',
      merge_commit_sha: 'merge62', updated_at: '2026-08-01T19:28:00Z', created_at: OLD,
      head: { ref: `auto/dev-${ID}`, sha: 'h62' }, title: 'ok row', labels: [] },
  ];
  const restore = stubGitHub({
    pulls,
    deployRuns: [{ head_sha: 'merge62', status: 'completed', conclusion: 'success', head_branch: 'main' }],
  });

  const supabase = makeSupabase({
    dev_build_requests: [
      // No id -> row.id.slice() throws inside reconcileRow.
      { id: null, status: 'deploying', title: 'poison', created_at: OLD, pr_number: 62, history: [] },
      { id: ID, status: 'deploying', title: 'ok row', created_at: OLD, pr_number: 62, history: [] },
    ],
  });

  const result = await runReconcileTick({ supabase });
  restore();

  const good = supabase._store.dev_build_requests.find((r) => r.id === ID);
  assert.equal(good.status, 'deployed', 'the row behind the poison row is still reconciled');
  assert.equal(result.patched, 1);
});

test('the tick reports its own health', async () => {
  const restore = stubGitHub({ pulls: [], deployRuns: [] });
  await runReconcileTick({ supabase: makeSupabase() });
  restore();
  const s = reconcileStatus();
  assert.ok(s.at, 'last tick time is exposed so a stall is visible from outside');
  assert.equal(s.error, null);
});

// ─── Arbitration with the stage-timeout sweep ────────────────────────────────
//
// A retired row gave its concurrency slot back. Re-arming it takes the slot
// again and the sweep retires it 60 seconds later — a fight that costs the
// queue, not just the history log.

test('a timed-out row is not dragged back in flight by an open PR', () => {
  const retired = row({ status: 'needs_attention', timed_out_at: '2026-08-03T19:00:00Z' });

  const green = deriveState({ row: retired, pr: openPr(), checks: 'passed', now: NOW });
  assert.equal(green.status, undefined, 'green-but-unmerged must not re-arm a retired row');
  assert.equal(green.pr_number, 12, 'GitHub still updates what it genuinely knows');
  assert.equal(green.checks_status, 'passed');

  const running = deriveState({ row: retired, pr: openPr(), checks: 'running', now: NOW });
  assert.equal(running.status, undefined);
});

test('terminal truth still wins over a stage timeout, and clears the marker', () => {
  const retired = row({ status: 'needs_attention', timed_out_at: '2026-08-03T19:00:00Z' });

  const shipped = deriveState({
    row: retired,
    pr: mergedPr(),
    deploy: { status: 'completed', conclusion: 'success' },
    now: NOW,
  });
  assert.equal(shipped.status, 'deployed', 'a change that actually shipped is not stuck');
  assert.equal(shipped.timed_out_at, null, 'the timeout marker is cleared with it');

  const closed = deriveState({ row: retired, pr: { ...openPr(), state: 'closed', merged_at: null }, now: NOW });
  assert.equal(closed.status, 'superseded');
  assert.equal(closed.timed_out_at, null);
});
