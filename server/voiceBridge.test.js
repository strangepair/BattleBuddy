import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEAK_TOPIC, noteVoiceRoom, getVoiceRoom, clearVoiceRoomByName,
  clearVoiceRoomForUser, speakInVoiceRoom, toSpeakableText, _resetVoiceRooms,
} from './voiceBridge.js';

beforeEach(() => _resetVoiceRooms());

function collector() {
  const sent = [];
  return { sent, send: async (room, payload) => { sent.push({ room, payload }); } };
}

test('a reply reaches the room the user is live in', async () => {
  const { sent, send } = collector();
  noteVoiceRoom('mike', 'bb-session-1');

  const result = await speakInVoiceRoom('mike', 'Hey, glad you called.', { send });

  assert.equal(result.spoken, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, 'bb-session-1');
  assert.equal(sent[0].payload.type, 'speak');
  assert.equal(sent[0].payload.text, 'Hey, glad you called.');
  assert.ok(sent[0].payload.id, 'every packet carries an id so a redelivery is not spoken twice');
});

test('a text-only user is a silent no-op, not an error', async () => {
  const { sent, send } = collector();
  const result = await speakInVoiceRoom('someone-typing', 'Hello', { send });
  assert.deepEqual(result, { spoken: false, reason: 'no_active_room' });
  assert.equal(sent.length, 0);
});

test('each turn gets a distinct id', async () => {
  const { sent, send } = collector();
  noteVoiceRoom('mike', 'bb-1');
  await speakInVoiceRoom('mike', 'one', { send });
  await speakInVoiceRoom('mike', 'two', { send });
  assert.notEqual(sent[0].payload.id, sent[1].payload.id);
});

test('a finished room stops receiving replies', async () => {
  const { sent, send } = collector();
  noteVoiceRoom('mike', 'bb-1');
  clearVoiceRoomByName('bb-1');
  const result = await speakInVoiceRoom('mike', 'anyone there?', { send });
  assert.equal(result.spoken, false);
  assert.equal(sent.length, 0);
});

test('a mapping expires on its own if room_finished never arrives', () => {
  const t0 = 1_000_000;
  noteVoiceRoom('mike', 'bb-1', t0);
  assert.equal(getVoiceRoom('mike', t0 + 60_000), 'bb-1');
  assert.equal(getVoiceRoom('mike', t0 + 2 * 60 * 60 * 1000), null);
});

test('reconnecting re-points the user at the new room', async () => {
  const { sent, send } = collector();
  noteVoiceRoom('mike', 'bb-old');
  noteVoiceRoom('mike', 'bb-new');
  await speakInVoiceRoom('mike', 'hi', { send });
  assert.equal(sent[0].room, 'bb-new');
});

test('a send failure never throws — the chat reply was already delivered', async () => {
  noteVoiceRoom('mike', 'bb-1');
  const result = await speakInVoiceRoom('mike', 'hi', {
    send: async () => { throw new Error('livekit unreachable'); },
  });
  assert.equal(result.spoken, false);
  assert.equal(result.reason, 'send_failed');
});

test('empty or whitespace replies are not published', async () => {
  const { sent, send } = collector();
  noteVoiceRoom('mike', 'bb-1');
  assert.equal((await speakInVoiceRoom('mike', '', { send })).reason, 'empty_text');
  assert.equal((await speakInVoiceRoom('mike', '   \n ', { send })).reason, 'empty_text');
  assert.equal(sent.length, 0);
});

test('the topic is namespaced so the client cannot mistake it for its own data', () => {
  // The mobile client listens on the default topic for the bare string
  // "VOICE_FAILURE"; anything published there is parsed by it.
  assert.equal(SPEAK_TOPIC, 'bb.speak');
});

test('markdown is stripped but words are kept', () => {
  assert.equal(toSpeakableText('**Nice** work'), 'Nice work');
  assert.equal(toSpeakableText('that _really_ counts'), 'that really counts');
  assert.equal(toSpeakableText('see [the plan](https://x.dev/p)'), 'see the plan');
  assert.equal(toSpeakableText('## Heading\nbody'), 'Heading\nbody');
  assert.equal(toSpeakableText('- first\n- second'), 'first\nsecond');
  assert.equal(toSpeakableText('use `breathe` now'), 'use breathe now');
});

test('an apostrophe or a lone asterisk in prose survives', () => {
  assert.equal(toSpeakableText("you're doing great"), "you're doing great");
  assert.equal(toSpeakableText('2 * 3 is six'), '2 * 3 is six');
});

test('an over-long reply is truncated rather than dropped', () => {
  const long = 'a'.repeat(9000);
  const out = toSpeakableText(long);
  assert.ok(out.length <= 8001, `expected a cap, got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('null-ish input is empty, not a crash', () => {
  assert.equal(toSpeakableText(null), '');
  assert.equal(toSpeakableText(undefined), '');
});

test('session end unmaps the user', async () => {
  const { sent, send } = collector();
  noteVoiceRoom('mike', 'bb-1');
  clearVoiceRoomForUser('mike');
  assert.equal((await speakInVoiceRoom('mike', 'hi', { send })).reason, 'no_active_room');
  assert.equal(sent.length, 0);
});
