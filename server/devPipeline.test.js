// Unit tests for the Developer-mode pipeline's pure logic. No network / no
// external deps (devPipeline imports only node:crypto), so this runs green even
// where the full server dependency tree can't be installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, looksForbidden, patchForEvent, isPipelineEnabled } from './devPipeline.js';

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
