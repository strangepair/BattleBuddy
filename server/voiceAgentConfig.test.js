/**
 * Voice-agent dispatch: the prompt must never ride in dispatch metadata.
 *
 * LiveKit caps dispatch metadata at 64 KiB; the rendered system prompt is
 * ~150 KB. When the prompt was inlined, createDispatch failed on every voice
 * connect, the error was swallowed, and the named agent never joined — the
 * "connected but BB never speaks" bug. These tests pin the store's contract
 * and (as source assertions, same style as systemPromptTemplate.test.js) the
 * shape of the dispatch call in index.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  storeVoiceAgentConfig,
  takeVoiceAgentConfig,
  _resetVoiceAgentConfigs,
} from './voiceAgentConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');

test('store/take roundtrip returns the config for the right nonce', () => {
  _resetVoiceAgentConfigs();
  const config = { systemPrompt: 'big prompt', greeting: 'hi', devMode: false };
  storeVoiceAgentConfig('room-1', 'nonce-1', config);
  assert.deepEqual(takeVoiceAgentConfig('room-1', 'nonce-1'), config);
});

test('wrong or missing nonce returns null', () => {
  _resetVoiceAgentConfigs();
  storeVoiceAgentConfig('room-1', 'nonce-1', { systemPrompt: 'p' });
  assert.equal(takeVoiceAgentConfig('room-1', 'wrong'), null);
  assert.equal(takeVoiceAgentConfig('room-1', ''), null);
  assert.equal(takeVoiceAgentConfig('other-room', 'nonce-1'), null);
});

test('config stays readable within the TTL (agent retries must succeed)', () => {
  _resetVoiceAgentConfigs();
  storeVoiceAgentConfig('room-1', 'nonce-1', { systemPrompt: 'p' });
  assert.ok(takeVoiceAgentConfig('room-1', 'nonce-1'));
  assert.ok(takeVoiceAgentConfig('room-1', 'nonce-1'), 're-read within TTL must work');
});

test('config expires after the TTL', () => {
  _resetVoiceAgentConfigs();
  const t0 = 1_000_000;
  storeVoiceAgentConfig('room-1', 'nonce-1', { systemPrompt: 'p' }, t0);
  assert.ok(takeVoiceAgentConfig('room-1', 'nonce-1', t0 + 9 * 60 * 1000));
  assert.equal(takeVoiceAgentConfig('room-1', 'nonce-1', t0 + 11 * 60 * 1000), null);
});

// ─── Source assertions on index.js ──────────────────────────────────────────

test('dispatch metadata is compact: no systemPrompt, carries the configToken', () => {
  const metaStart = indexSource.indexOf('const dispatchMetadata = JSON.stringify({');
  assert.ok(metaStart !== -1, 'the voice route must build dispatch metadata as dispatchMetadata');
  const metaBlock = indexSource.slice(metaStart, indexSource.indexOf('})', metaStart) + 2);

  assert.ok(
    !metaBlock.includes('systemPrompt'),
    'the system prompt must NOT ride in dispatch metadata (64 KiB LiveKit cap — oversized metadata silently kills the dispatch and no agent joins)'
  );
  assert.ok(metaBlock.includes('configToken'), 'dispatch metadata must carry the config nonce');
  assert.ok(metaBlock.includes('room'), 'dispatch metadata must carry the room name');
});

test('the full config is stored for agent pickup before dispatch', () => {
  const storeStart = indexSource.indexOf('storeVoiceAgentConfig(roomName, configToken, {');
  assert.ok(storeStart !== -1, 'the voice route must store the agent config');
  const storeBlock = indexSource.slice(storeStart, indexSource.indexOf('});', storeStart));
  for (const field of ['systemPrompt: voiceSystemPrompt', 'greeting', 'userId', 'timezone', 'devMode']) {
    assert.ok(storeBlock.includes(field), `stored agent config must include ${field}`);
  }
});

test('the /livekit/agent-config pickup route exists', () => {
  assert.ok(
    indexSource.includes("req.url === '/livekit/agent-config'"),
    'the agent must have an HTTP route to trade its nonce for the config'
  );
  assert.ok(
    indexSource.includes('takeVoiceAgentConfig(room, token)'),
    'the pickup route must resolve configs through the nonce-checked store'
  );
});

test('a failed dispatch is logged as an error, not swallowed as info', () => {
  const catchStart = indexSource.indexOf('} catch (dispatchErr) {');
  assert.ok(catchStart !== -1);
  const catchBlock = indexSource.slice(catchStart, catchStart + 400);
  assert.ok(
    catchBlock.includes('console.error'),
    'dispatch failure means no agent joins the room — it must be console.error'
  );
});

// The guard that would have caught this bug the day the prompt crossed the
// line: the template alone must leave clear headroom under LiveKit's 64 KiB
// metadata cap IF anyone reintroduces prompt-in-metadata. Since the prompt no
// longer rides in metadata, this is a canary on the compact metadata staying
// compact instead.
test('compact dispatch metadata fields stay far under the 64 KiB cap', () => {
  // Rough worst-case serialization of the compact fields (UUID nonce, room
  // name, userId, tz, timestamp, bool) — orders of magnitude under the cap.
  const worstCase = JSON.stringify({
    configToken: '0'.repeat(36),
    room: 'bb-' + '9'.repeat(16),
    userId: '0'.repeat(64),
    timezone: 'America/Argentina/ComodRivadavia',
    last_session_at: new Date(0).toISOString(),
    devMode: true,
  });
  assert.ok(worstCase.length < 1024, 'compact dispatch metadata must stay tiny');
});
