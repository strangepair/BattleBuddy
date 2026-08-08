/**
 * Voice happy-path regression guards.
 *
 * The four acceptance criteria for voice mode are:
 *   1. Switching text→voice triggers a spoken + displayed greeting.
 *   2. User speech is transcribed live in the chat stream while speaking.
 *   3. After the user stops speaking, BB responds with synthesised voice.
 *   4. BB's response is simultaneously transcribed and displayed in the stream.
 *
 * These tests guard the static source-code invariants that enable each step.
 * They run in jest-node with no native stack, so they read the actual source
 * files rather than instantiating LiveKit or the store.
 *
 * The regression that broke (2) was: TranscriptCapture never allocated a
 * partial-user bubble; non-final STT segments were silently dropped and
 * nothing appeared in the stream until the user finished speaking.
 *
 * The regression that broke (3) + (4) was: the original TranscriptCapture
 * called addUserMessage directly on final segments, which appended the bubble
 * but never called sendMessage — so the agent received nothing and no LLM
 * turn fired.
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';

const cwd = process.cwd();

const voiceSrc = readFileSync(
  resolve(cwd, 'src/components/session/VoiceSession.tsx'),
  'utf8',
);

const storeSrc = readFileSync(
  resolve(cwd, 'src/stores/sessionStore.ts'),
  'utf8',
);

// ── 1. Live user transcript display (Acceptance criterion 2) ─────────────────

test('TranscriptCapture allocates a live user bubble on the first non-final segment', () => {
  expect(voiceSrc).toMatch(/liveUserMsgId/);
  expect(voiceSrc).toMatch(/addUserMsg\s*\(/);
  const partialBlock = voiceSrc.match(/if\s*\(!isFinal\)[\s\S]*?} else {[\s\S]*?onTranscript/);
  expect(partialBlock).not.toBeNull();
});

test('TranscriptCapture updates the live bubble on subsequent non-final segments', () => {
  expect(voiceSrc).toMatch(/updateUserMsg\s*\(/);
  expect(voiceSrc).toMatch(/liveUserMsgId\.current,\s*text/);
});

test('TranscriptCapture clears the live bubble before routing the final segment to onTranscript', () => {
  expect(voiceSrc).toMatch(/liveUserMsgId\.current\s*=\s*null/);
  const clearThenRoute = voiceSrc.match(
    /liveUserMsgId\.current\s*=\s*null[\s\S]{0,200}onTranscript\s*\(/,
  );
  expect(clearThenRoute).not.toBeNull();
});

// ── 2. Final transcript routes to the agent (Acceptance criterion 3) ─────────

test('final user transcript calls onTranscript, not addUserMessage directly', () => {
  const transcriptCaptureFn = voiceSrc.match(
    /function TranscriptCapture[\s\S]*?^}/m,
  );
  expect(transcriptCaptureFn).not.toBeNull();
  const body = transcriptCaptureFn![0];

  // onTranscript must be called for the final user segment.
  expect(body).toMatch(/onTranscript\s*\(/);

  // addUserMessage must NOT be called directly for the final segment — it must
  // go through onTranscript (which routes through handleUserTurn → sendMessage).
  // The only addUserMessage reference allowed here is via the addUserMsg alias
  // used for the partial (non-final) bubble.
  const directFinalCall = body.match(/(?<!\/\/.*)addUserMessage\s*\(\s*text\s*\)/);
  expect(directFinalCall).toBeNull();
});

// ── 3. Agent transcript produces a single updating bubble (Acceptance criterion 4) ──

test('agent non-final segments reuse the same bubble via updateAssistantMsg', () => {
  expect(voiceSrc).toMatch(/lastAgentMsgId\.current\s*=\s*addAssistantMsg\(\)/);
  expect(voiceSrc).toMatch(/updateAssistantMsg\s*\(\s*lastAgentMsgId\.current/);
});

test('agent final segment commits the bubble and resets lastAgentMsgId', () => {
  expect(voiceSrc).toMatch(/lastAgentMsgId\.current\s*=\s*null/);
});

// ── 4. onTranscript prop is threaded from VoiceSession into TranscriptCapture ──

test('VoiceSession passes onTranscript to TranscriptCapture', () => {
  expect(voiceSrc).toMatch(/<TranscriptCapture[^/]*onTranscript\s*=\s*\{onTranscript\}/);
});

test('VoiceSession interface declares onTranscript as an optional prop', () => {
  expect(voiceSrc).toMatch(/onTranscript\?\s*:\s*\(\s*text\s*:\s*string\s*\)\s*=>/);
});

// ── 5. sessionStore exposes updateUserMessage (enables live display) ──────────

test('sessionStore declares updateUserMessage in the interface', () => {
  expect(storeSrc).toMatch(/updateUserMessage\s*:\s*\(\s*id\s*:\s*string,\s*content\s*:\s*string\s*\)\s*=>\s*void/);
});

test('sessionStore implements updateUserMessage to update in place', () => {
  expect(storeSrc).toMatch(/updateUserMessage:\s*\(\s*id,\s*content\s*\)\s*=>/);
  expect(storeSrc).toMatch(/m\.id\s*===\s*id\s*\?\s*\{\s*\.\.\.m,\s*content\s*\}/);
});

test('addUserMessage returns the new message id so TranscriptCapture can track the live bubble', () => {
  expect(storeSrc).toMatch(/addUserMessage.*:\s*\(content.*\)\s*=>\s*string/);
  expect(storeSrc).toMatch(/return\s+msg\.id/);
});

// ── 6. Voice switch greeting path (Acceptance criterion 1) ───────────────────

test('server greeting.js returns a switching-to-voice instruction for continuations', () => {
  const greetingSrc = readFileSync(
    resolve(cwd, join('..', 'server', 'greeting.js')),
    'utf8',
  );
  expect(greetingSrc).toMatch(/switching to voice/i);
  expect(greetingSrc).toMatch(/isContinuation/);
});

test('agent.py generates a reply with the greeting instruction on session start', () => {
  const agentSrc = readFileSync(
    resolve(cwd, join('..', 'agent', 'agent.py')),
    'utf8',
  );
  expect(agentSrc).toMatch(/generate_reply\s*\([\s\S]*?instructions\s*=\s*greeting\s*\)/);
});
