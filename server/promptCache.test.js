/**
 * Run with: node --test server/
 *
 * Uses node:test (built into Node 20+) rather than adding a test framework —
 * CLAUDE.md asks before new third-party deps, and the server had no harness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { toCachedSystemBlocks, CACHE_SPLIT_MARKER } from './promptCache.js';

const here = dirname(fileURLToPath(import.meta.url));

test('splits into a cached static block and an uncached volatile block', () => {
  const blocks = toCachedSystemBlocks(`persona text\n${CACHE_SPLIT_MARKER}\nper-turn data`);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'persona text\n');
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[1].text, `${CACHE_SPLIT_MARKER}\nper-turn data`);
  // Only the static block carries a breakpoint — a second one would cache
  // per-turn data.
  assert.equal(blocks[1].cache_control, undefined);
});

test('the split is lossless', () => {
  const prompt = `alpha\n${CACHE_SPLIT_MARKER}\nbeta`;
  const blocks = toCachedSystemBlocks(prompt);
  assert.equal(blocks[0].text + blocks[1].text, prompt);
});

test('falls back to an uncached string when the marker is missing', () => {
  // The agent design loop edits the prompt file unattended, so a renamed
  // section is a live risk. Degrading to uncached is correct; caching a prefix
  // that now holds per-turn data would leak one user's context into the next.
  const prompt = 'a prompt with no runtime section';
  assert.equal(toCachedSystemBlocks(prompt), prompt);
});

test('real system prompt: no per-turn placeholder lands in the cached block', () => {
  const prompt = readFileSync(join(here, 'prompts/system.battlebuddy.md'), 'utf-8');
  const blocks = toCachedSystemBlocks(prompt);

  assert.ok(Array.isArray(blocks), 'marker must be present in the shipped prompt');

  // `{{placeholders}}` on line 5 is prose describing the convention, not a
  // substitution — every other {{...}} must be below the split.
  const leaked = (blocks[0].text.match(/\{\{[a-z_]+\}\}/g) || [])
    .filter(p => p !== '{{placeholders}}');
  assert.deepEqual(leaked, [], `per-turn placeholders leaked into the cached block: ${leaked}`);
});

test('real system prompt: cached block clears Haiku 4.5 minimum of 4096 tokens', () => {
  const prompt = readFileSync(join(here, 'prompts/system.battlebuddy.md'), 'utf-8');
  const blocks = toCachedSystemBlocks(prompt);

  // ~4 chars/token. Below the floor the API silently declines to cache — no
  // error, just cache_creation_input_tokens: 0 — so assert with real headroom.
  const estimatedTokens = blocks[0].text.length / 4;
  assert.ok(
    estimatedTokens > 4096,
    `cached block is only ~${Math.round(estimatedTokens)} tokens; Haiku needs >4096`
  );
});
