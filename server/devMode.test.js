/**
 * check_dev_mode must report the TRUE toggle state of the request, and the
 * tool must exist everywhere the prompt says it does.
 *
 * Regression coverage for the build-55 field failure: the shared prompt
 * documented `check_dev_mode()` but the voice agent had no such tool (the
 * model flip-flopped between claiming and denying it), and OFF was
 * represented only by the absence of the Developer Session block, so stale
 * conversation history kept the model believing dev mode was on after the
 * toggle flipped off.
 *
 * Functional tests hit devMode.js directly; wiring checks read the sources
 * as text (importing index.js would start the HTTP server).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { checkDevModeToolResult, devModeStatusBlock } from './devMode.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');
const agentSource = readFileSync(join(here, '../agent/agent.py'), 'utf-8');

test('check_dev_mode returns true when the request carries devMode: true', () => {
  const result = checkDevModeToolResult('toolu_01', { devMode: true });
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'toolu_01');
  const payload = JSON.parse(result.content);
  assert.equal(payload.dev_mode, true);
  assert.match(payload.meaning, /Developer mode is ON/);
});

test('check_dev_mode returns false when the request carries devMode: false', () => {
  const payload = JSON.parse(checkDevModeToolResult('toolu_02', { devMode: false }).content);
  assert.equal(payload.dev_mode, false);
  assert.match(payload.meaning, /Developer mode is OFF/);
});

test('check_dev_mode defaults to false when devMode is missing or non-boolean', () => {
  // A request that never sent the flag (old client, voice path pre-fix) must
  // read as companion mode, and a string "true" must not count as on.
  for (const ctx of [{}, undefined, { devMode: 'true' }, { devMode: 1 }]) {
    const payload = JSON.parse(checkDevModeToolResult('toolu_03', ctx).content);
    assert.equal(payload.dev_mode, false, `context ${JSON.stringify(ctx)} must read as OFF`);
  }
});

test('the prompt status block states the live value in BOTH states', () => {
  const on = devModeStatusBlock(true);
  const off = devModeStatusBlock(false);
  assert.match(on, /Developer mode is ON for this turn/);
  assert.match(off, /Developer mode is OFF for this turn/);
  // The whole point: the live value must override stale conversation history.
  assert.match(on, /overrides anything earlier in the conversation/);
  assert.match(off, /overrides anything earlier in the conversation/);
});

test('buildSystemPrompt appends the status block unconditionally', () => {
  assert.ok(
    indexSource.includes('devModeStatusBlock(devMode)'),
    'buildSystemPrompt must append devModeStatusBlock in both states — OFF-by-absence is the bug'
  );
});

test('executeToolUse delegates check_dev_mode to the shared helper', () => {
  assert.ok(
    indexSource.includes('checkDevModeToolResult(toolUse.id, requestContext)'),
    'executeToolUse must answer check_dev_mode from the request context via devMode.js'
  );
});

test('the text turn always declares the full tool list', () => {
  // The model can only rely on check_dev_mode if the declaration is
  // unconditional — a tool list that varies per turn is what "I have it /
  // I don\'t" flip-flopping looks like from the user's side.
  assert.ok(
    indexSource.includes('tools: AGENT_TOOLS'),
    'streamTextTurn must pass AGENT_TOOLS on every model call'
  );
  assert.ok(
    !/tools:\s*devMode/.test(indexSource) && !/devMode\s*\?\s*AGENT_TOOLS/.test(indexSource),
    'the tool list must not be conditional on devMode'
  );
});

test('the voice agent declares check_dev_mode and answers from dispatch metadata', () => {
  // The prompt template (shared by text and voice) documents check_dev_mode,
  // so the voice tool list must include it too — this is the mismatch that
  // made the voice model deny, claim, then "admit fabricating" the tool.
  assert.ok(
    agentSource.includes('async def check_dev_mode'),
    'agent.py must declare a check_dev_mode function tool'
  );
  const toolBody = agentSource.slice(agentSource.indexOf('async def check_dev_mode'));
  assert.ok(
    toolBody.slice(0, 1500).includes('dispatch_meta.get("devMode"'),
    'voice check_dev_mode must report the devMode carried on the dispatch metadata'
  );
});
