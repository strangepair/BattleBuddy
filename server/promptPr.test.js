/**
 * The design loop's output contract: propose, never apply.
 *
 * These tests exist because the failure they guard against is invisible. The
 * loop runs unattended once a day; if it silently went back to writing the live
 * prompt, or filed a row the worker would happily dispatch as a build, or named
 * its branch something the reconciler cannot recognise, nothing would fail
 * loudly — it would just quietly stop being governed again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMPT_REPO_PATH,
  PR_TITLE,
  applyPatches,
  branchFor,
  buildCommitMessage,
  buildPipelineRow,
  buildPrBody,
  parsePatchBlocks,
} from './promptPr.js';

const ID = '11111111-2222-3333-4444-555555555555';

// Copied verbatim from devReconcile.js. Duplicated on purpose: the point is to
// detect a change on EITHER side, which an import could not do.
const RECONCILER_BRANCH_RE = /^auto\/dev-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RECONCILER_TRAILER_RE = /^Dev-Request-Id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;

// ── Patch mechanics ──────────────────────────────────────────────────────────

test('parsePatchBlocks reads every block and ignores prose around them', () => {
  const patches = parsePatchBlocks(
    'Here you go:\n' +
    '<<<FIND>>>\nold one\n<<<REPLACE>>>\nnew one\n<<<END>>>\n' +
    'and another\n' +
    '<<<FIND>>>\nold two\nsecond line\n<<<REPLACE>>>\nnew two\n<<<END>>>\n',
  );
  assert.deepEqual(patches, [
    { find: 'old one', replace: 'new one' },
    { find: 'old two\nsecond line', replace: 'new two' },
  ]);
});

test('parsePatchBlocks returns nothing when the model emitted no patches', () => {
  assert.deepEqual(parsePatchBlocks('There are no HIGH confidence proposals.'), []);
});

test('applyPatches applies what matches and skips what does not', () => {
  const base = 'alpha\nbravo\ncharlie\n';
  const result = applyPatches(base, [
    { find: 'bravo', replace: 'BRAVO' },
    { find: 'not in the file', replace: 'nope' },
  ]);
  assert.equal(result.content, 'alpha\nBRAVO\ncharlie\n');
  assert.equal(result.applied, 1);
  assert.equal(result.total, 2);
});

test('applyPatches leaves the base untouched when nothing matches', () => {
  const base = 'alpha\nbravo\n';
  const result = applyPatches(base, [{ find: 'zulu', replace: 'ZULU' }]);
  assert.equal(result.content, base);
  assert.equal(result.applied, 0);
});

// ── Branch + commit: the reconciler's two ways of linking a PR to its row ─────

test('the branch name is the shape devReconcile links on', () => {
  const branch = branchFor(ID);
  assert.equal(branch, `auto/dev-${ID}`);
  const m = branch.match(RECONCILER_BRANCH_RE);
  assert.ok(m, 'branch must match devReconcile.js UUID_RE or a lost pr_number can never re-link');
  assert.equal(m[1], ID);
});

test('the commit message carries the Dev-Request-Id trailer', () => {
  const msg = buildCommitMessage(ID, 'Tightened the urge-wave wording.');
  const m = msg.match(RECONCILER_TRAILER_RE);
  assert.ok(m, 'trailer must match devReconcile.js TRAILER_RE');
  assert.equal(m[1], ID);
  assert.ok(msg.startsWith(PR_TITLE));
});

test('the commit message survives an empty summary', () => {
  const msg = buildCommitMessage(ID, '');
  assert.match(msg, RECONCILER_TRAILER_RE);
  assert.match(msg, /HIGH-confidence proposals/);
});

// ── The PR body ──────────────────────────────────────────────────────────────

test('the PR body says it is a proposal and shows the evidence behind it', () => {
  const body = buildPrBody({
    requestId: ID,
    summary: '- Softened the check-in opener.',
    proposalText: 'SECTION: openers\nCONFIDENCE: HIGH',
    digest: { totalSessions: 12, totalUsers: 3 },
    patchCount: 2,
    sizeCheck: { bytes: 54210 },
  });

  assert.match(body, /proposal, not an applied change/i);
  assert.match(body, /12 session\(s\)/);
  assert.match(body, /3 user\(s\)/);
  assert.match(body, /2 HIGH-confidence patch\(es\)/);
  assert.ok(body.includes(PROMPT_REPO_PATH));
  assert.match(body, /- Softened the check-in opener\./);
  assert.match(body, /54210 bytes/);
  assert.match(body, RECONCILER_TRAILER_RE);
});

test('the PR body lists what was skipped before the PR was opened', () => {
  const body = buildPrBody({
    requestId: ID,
    summary: 'x',
    proposalText: '',
    digest: { totalSessions: 1, totalUsers: 1 },
    patchCount: 1,
    sizeCheck: { bytes: 1 },
    skipped: ['a third patch dropped: FIND text did not match'],
  });
  assert.match(body, /## Skipped before this PR was opened/);
  assert.match(body, /a third patch dropped/);
});

// ── The pipeline row ─────────────────────────────────────────────────────────

test('an opened proposal becomes a reviewable in_review pipeline item', () => {
  const row = buildPipelineRow({
    requestId: ID,
    summary: 'Softened the opener.',
    prNumber: 321,
    prUrl: 'https://github.com/strangepair/BattleBuddy/pull/321',
    branch: branchFor(ID),
    patchCount: 1,
    digest: { totalSessions: 9, totalUsers: 2 },
  });

  assert.equal(row.id, ID);
  assert.equal(row.source, 'design-loop');
  assert.equal(row.target, 'prompt');
  assert.equal(row.status, 'in_review');
  assert.equal(row.pr_number, 321);
  assert.equal(row.checks_status, 'running');
  assert.equal(row.branch, `auto/dev-${ID}`);
  assert.equal(row.error, null);
  assert.deepEqual(row.spec.affectedFiles, [PROMPT_REPO_PATH]);
  assert.equal(row.spec.sessionsAnalyzed, 9);
});

test('a proposal that could not become a PR still lands, as needs_attention', () => {
  const row = buildPipelineRow({
    requestId: ID,
    summary: 'Softened the opener.',
    prNumber: null,
    prUrl: null,
    branch: branchFor(ID),
    patchCount: 1,
    digest: { totalSessions: 9, totalUsers: 2 },
    error: 'github 403 for pulls',
  });

  assert.equal(row.status, 'needs_attention');
  assert.equal(row.pr_number, null);
  assert.match(row.error, /github 403/);
  assert.match(row.history[0].note, /could not be opened as a PR/);
});

test('a design-loop row is never dispatchable as a build', () => {
  // runDevBuildWorker selects `status = 'pending'`. The change is already
  // written on the branch, so a pending design-loop row would send Claude Code
  // off to re-implement a prompt edit that already exists.
  for (const prNumber of [321, null]) {
    const row = buildPipelineRow({
      requestId: ID, summary: '', prNumber, prUrl: null,
      branch: branchFor(ID), patchCount: 1, digest: {}, error: 'x',
    });
    assert.notEqual(row.status, 'pending');
  }
});

test('the dedupe key is unique per run so a proposal can never block intake', () => {
  const other = '99999999-8888-7777-6666-555555555555';
  const a = buildPipelineRow({ requestId: ID, prNumber: 1, branch: '', patchCount: 1, digest: {} });
  const b = buildPipelineRow({ requestId: other, prNumber: 2, branch: '', patchCount: 1, digest: {} });
  assert.notEqual(a.dedupe_key, b.dedupe_key);
  assert.match(a.dedupe_key, /^design-loop:/);
});
