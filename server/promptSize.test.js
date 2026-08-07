/**
 * Prompt size gate — fails CI if system.battlebuddy.md re-bloats.
 *
 * The prompt is injected on every turn; its size is latency, cost, and (in
 * voice) a hard functional limit — the filled prompt must fit LiveKit's 64 KB
 * dispatch-metadata cap. The nightly design loop once grew this file from
 * ~43 KB to ~153 KB in ten days. This test is the merge gate that makes that
 * impossible to repeat silently; agentDesignLoop.js enforces the same numbers
 * at write time for the git-less production path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  MAX_PROMPT_BYTES,
  MAX_GROWTH_PER_RUN_BYTES,
  REQUIRED_MARKERS,
  checkPromptSize,
  findMissingMarkers,
  validateProposedPrompt,
} from './promptGuard.js';

const here = dirname(fileURLToPath(import.meta.url));
const promptPath = join(here, 'prompts/system.battlebuddy.md');

test('system.battlebuddy.md stays under the byte cap', () => {
  const content = readFileSync(promptPath, 'utf-8');
  const { ok, bytes, violations } = checkPromptSize(content);
  assert.ok(
    ok,
    `${violations.join('; ')}\n` +
      `The prompt template must stay under ${MAX_PROMPT_BYTES} bytes (currently ${bytes}). ` +
      'Tighten or replace existing content instead of appending; per-user facts belong in the ' +
      'runtime context / user_facts store, not in this shared file. Raising the cap is a ' +
      'deliberate, reviewed change to server/promptGuard.js.'
  );
});

test('checkPromptSize flags an over-cap prompt', () => {
  const { ok, violations } = checkPromptSize('x'.repeat(MAX_PROMPT_BYTES + 1));
  assert.equal(ok, false);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /exceeds the \d+-byte cap/);
});

test('checkPromptSize flags over-budget growth in a single run', () => {
  const previous = 'x'.repeat(10_000);
  const grown = 'x'.repeat(10_000 + MAX_GROWTH_PER_RUN_BYTES + 1);
  const { ok, violations } = checkPromptSize(grown, { previous });
  assert.equal(ok, false);
  assert.match(violations[0], /per-run budget/);
});

test('checkPromptSize allows shrinkage and small growth', () => {
  const previous = 'x'.repeat(10_000);
  assert.equal(checkPromptSize('x'.repeat(9_000), { previous }).ok, true);
  assert.equal(checkPromptSize('x'.repeat(10_000 + MAX_GROWTH_PER_RUN_BYTES), { previous }).ok, true);
});

// ── Content integrity ────────────────────────────────────────────────────────
//
// The design loop proposes patches to this file unattended. Everything below is
// what a proposal has to clear before it is allowed to become a PR.

test('the live prompt actually contains every marker the guard requires', () => {
  // A guard that lists markers the file no longer has is a guard that passes
  // everything: findMissingMarkers would report them missing before AND after
  // any patch, and the design loop would refuse every proposal forever — or,
  // worse, someone would quietly delete the marker from the list.
  const content = readFileSync(promptPath, 'utf-8');
  assert.deepEqual(findMissingMarkers(content), []);
  assert.ok(REQUIRED_MARKERS.length >= 9);
});

test('validateProposedPrompt passes a small, marker-preserving edit', () => {
  const base = readFileSync(promptPath, 'utf-8');
  const proposed = base.replace('## Hard limits', '## Hard limits\n\n- One new reviewed line.');
  const { ok, violations } = validateProposedPrompt(proposed, base);
  assert.equal(ok, true, violations.join('; '));
});

test('validateProposedPrompt refuses a proposal that drops the 988 off-ramp', () => {
  const base = readFileSync(promptPath, 'utf-8');
  const proposed = base.split('988').join('###');
  const { ok, violations } = validateProposedPrompt(proposed, base);
  assert.equal(ok, false);
  assert.match(violations.join('; '), /required marker\(s\).*988/);
});

test('validateProposedPrompt refuses a proposal that blows the growth budget', () => {
  const base = readFileSync(promptPath, 'utf-8');
  const proposed = base + 'x'.repeat(MAX_GROWTH_PER_RUN_BYTES + 1);
  const { ok, violations } = validateProposedPrompt(proposed, base);
  assert.equal(ok, false);
  assert.match(violations.join('; '), /per-run budget/);
});

test('byte length is measured in UTF-8, not string length', () => {
  // The prompt contains em-dashes, curly quotes, and emoji — multi-byte in
  // UTF-8. A .length-based check would under-count and let bloat through.
  const { bytes } = checkPromptSize('café — ✅');
  assert.equal(bytes, Buffer.byteLength('café — ✅', 'utf-8'));
  assert.ok(bytes > 'café — ✅'.length);
});
