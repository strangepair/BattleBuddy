/**
 * Static checks on the system prompt template.
 *
 * Reads index.js as text rather than importing it — importing would start the
 * HTTP server. That keeps these cheap and dependency-free, and they catch the
 * failure mode that matters: a placeholder added to the template with no
 * matching substitution, which ships the literal `{{...}}` into a live prompt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, 'prompts/system.battlebuddy.md'), 'utf-8');
const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');

// Line 5 of the template describes the convention in prose ("`{{placeholders}}`
// are filled in per turn") — it is documentation, not a substitution site.
const DOC_ONLY = new Set(['{{placeholders}}']);

function templatePlaceholders() {
  return [...new Set(template.match(/\{\{[a-z_]+\}\}/g) || [])].filter(p => !DOC_ONLY.has(p));
}

test('every template placeholder has a matching .replace() in index.js', () => {
  const missing = templatePlaceholders().filter(p => !indexSource.includes(`.replace('${p}'`));
  assert.deepEqual(
    missing,
    [],
    `template placeholders with no substitution — these would render literally to a user: ${missing.join(', ')}`
  );
});

test('every .replace() target still exists in the template', () => {
  // The reverse direction: a substitution left behind after its section was
  // removed is dead code, and silently drops whatever it was carrying.
  const replaced = [...new Set(
    (indexSource.match(/\.replace\('(\{\{[a-z_]+\}\})'/g) || [])
      .map(m => m.match(/\{\{[a-z_]+\}\}/)[0])
  )];
  const orphaned = replaced.filter(p => !template.includes(p));
  assert.deepEqual(orphaned, [], `substitutions with no placeholder in the template: ${orphaned.join(', ')}`);
});

test('promoted memory tier is wired end to end', () => {
  // The tier is only useful if it reaches both paths. Voice is the one that
  // matters most — it had no memory at all, which is why greetings read cold.
  assert.ok(template.includes('{{promoted_memories}}'), 'template is missing the promoted tier');
  assert.ok(indexSource.includes('fetchPromotedMemories'), 'index.js never fetches promoted memories');

  const voiceCall = indexSource.slice(indexSource.indexOf('const voiceSystemPrompt = buildSystemPrompt({'));
  const voiceArgs = voiceCall.slice(0, voiceCall.indexOf('});'));
  assert.ok(
    voiceArgs.includes('promotedMemories'),
    'the voice path builds its prompt without the promoted tier — greetings stay memory-blind'
  );
});

test('devMode flag is accepted by buildSystemPrompt', () => {
  assert.ok(
    indexSource.includes('devMode = false'),
    'buildSystemPrompt must have devMode defaulting to false'
  );
  assert.ok(
    indexSource.includes('if (devMode)'),
    'buildSystemPrompt must branch on devMode'
  );
  assert.ok(
    indexSource.includes('## Developer Session'),
    'buildSystemPrompt must append the Developer Session block when devMode is true'
  );
});

test('devMode is extracted and forwarded in the /session/turn route', () => {
  const turnRouteStart = indexSource.indexOf("req.url === '/session/turn'");
  const turnRouteEnd = indexSource.indexOf("req.url === '/livekit/token'");
  const turnSource = indexSource.slice(turnRouteStart, turnRouteEnd);

  assert.ok(
    turnSource.includes('devMode') && turnSource.includes('JSON.parse(body)'),
    '/session/turn must destructure devMode from the request body'
  );
  assert.ok(
    turnSource.includes('devMode: devMode === true'),
    '/session/turn must pass devMode to buildSystemPrompt'
  );
});

test('devMode is forwarded in the /livekit/token route and included in agent dispatch metadata', () => {
  const voiceRouteStart = indexSource.indexOf("req.url === '/livekit/token'");
  const voiceSource = indexSource.slice(voiceRouteStart, voiceRouteStart + 4000);

  assert.ok(
    voiceSource.includes('devMode') && voiceSource.includes('JSON.parse(body)'),
    '/livekit/token must destructure devMode from the request body'
  );

  const voiceCall = indexSource.slice(indexSource.indexOf('const voiceSystemPrompt = buildSystemPrompt({'));
  const voiceArgs = voiceCall.slice(0, voiceCall.indexOf('});'));
  assert.ok(
    voiceArgs.includes('devMode: devMode === true'),
    'the voice path must pass devMode to buildSystemPrompt'
  );

  // devMode now rides in the compact dispatch metadata (the full prompt moved
  // to the voiceAgentConfig store — see voiceDispatch.test.js for why).
  const metaStart = indexSource.indexOf('const dispatchMetadata = JSON.stringify({');
  assert.ok(metaStart !== -1, 'the voice route must build compact dispatch metadata');
  const metaArgs = indexSource.slice(metaStart, indexSource.indexOf('})', metaStart) + 2);
  assert.ok(
    metaArgs.includes('devMode'),
    'the agent dispatch metadata must include the devMode field'
  );
});

test('check_dev_mode tool is wired end to end', () => {
  // The agent is instructed (in the prompt) to verify dev-mode state via the
  // tool whenever the user mentions dev mode + creating a PR. That only works
  // if all four layers agree: tool declared, executor handles it, the turn
  // loop threads the request's devMode down, and the prompt documents it.
  assert.ok(
    indexSource.includes("name: 'check_dev_mode'"),
    'AGENT_TOOLS must declare check_dev_mode'
  );
  assert.ok(
    indexSource.includes("toolUse.name === 'check_dev_mode'"),
    'executeToolUse must handle check_dev_mode'
  );
  assert.ok(
    indexSource.includes('executeToolUse(toolUse, effectiveUserId, timezone, requestContext)'),
    'the tool loop must pass the request context (devMode) to executeToolUse'
  );
  const turnRouteStart = indexSource.indexOf("req.url === '/session/turn'");
  const turnRouteEnd = indexSource.indexOf("req.url === '/livekit/token'");
  const turnSource = indexSource.slice(turnRouteStart, turnRouteEnd);
  assert.ok(
    turnSource.includes('{ devMode: devMode === true, sessionId }'),
    '/session/turn must hand the request devMode (and sessionId, for fact-tool evidence) to streamTextTurn'
  );
  assert.ok(
    template.includes('`check_dev_mode()`'),
    'the prompt tools section must document check_dev_mode'
  );
  assert.ok(
    /check_dev_mode\(\)`[^\n]*(dev mode|developer mode)/i.test(template) &&
      /check_dev_mode\(\)`[^\n]*PR/.test(template),
    'the prompt must instruct checking the tool when the user mentions dev mode / creating a PR'
  );
});
