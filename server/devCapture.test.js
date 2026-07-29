// Tests for server-side dev-mode capture (devCapture.js).
//
// The point being proven: a dev-mode conversation produces dev_build_requests
// rows WITHOUT any client session-end event — the exact gap that left the old
// /dev/capture path dead. No network: Anthropic and Supabase are stubbed, but
// the flush runs through the real generateProductRequests + insertRequests.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  recordTextTurn,
  recordVoiceSessionStart,
  recordVoiceTranscript,
  sweepIdleSegments,
  flushAllSegments,
  registerShutdownFlush,
  _resetCaptureState,
  _captureSegmentCount,
} from './devCapture.js';

const TASK = {
  title: 'Add a streak counter to the session header',
  target: 'ui',
  description: 'Show the current resist streak.',
  acceptanceCriteria: ['streak visible'],
  affectedFiles: ['mobile/app/(app)/session.tsx'],
  claudeCodePrompt: 'Add a streak counter.',
  confidence: 0.9,
};

function fakeAnthropic(tasks = [TASK]) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return { content: [{ type: 'text', text: JSON.stringify(tasks) }] };
      },
    },
  };
}

// Just enough of the supabase-js chain for insertRequests: the dedupe lookup
// (.select().in().not() → awaited) and the insert (.insert().select() → awaited).
function fakeSupabase() {
  const inserted = [];
  return {
    inserted,
    from() {
      return {
        select() { return this; },
        in() { return this; },
        not: async () => ({ data: [] }),
        insert(rows) {
          inserted.push(...rows);
          return { select: async () => ({ data: rows }) };
        },
      };
    },
  };
}

function deps(anthropic, supabase) {
  return { anthropic, supabase, resolveUserId: (id) => String(id) };
}

const MSGS = [
  { role: 'user', content: 'Hey buddy, dev mode question' },
  { role: 'assistant', content: 'Dev mode is on — what should we build?' },
  { role: 'user', content: 'Add a streak counter to the session header' },
];

beforeEach(() => _resetCaptureState());

test('text: dev turns accumulate silently, toggle-off flushes into dev_build_requests', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  recordTextTurn(d, { userId: 'mike', sessionId: 's1', messages: MSGS.slice(0, 1), devMode: true });
  recordTextTurn(d, { userId: 'mike', sessionId: 's1', messages: MSGS, devMode: true });
  assert.equal(anthropic.calls.length, 0, 'no per-turn spec generation');
  assert.equal(supabase.inserted.length, 0);
  assert.equal(_captureSegmentCount(), 1);

  // The DEV toggle flips off → the next ordinary turn carries devMode=false.
  // That transition alone must flush — no client session-end anywhere.
  await recordTextTurn(d, { userId: 'mike', sessionId: 's1', messages: MSGS, devMode: false });

  assert.equal(anthropic.calls.length, 1, 'one spec generation per dev session');
  assert.equal(supabase.inserted.length, 1);
  const row = supabase.inserted[0];
  assert.equal(row.source, 'transcript');
  assert.equal(row.status, 'pending');
  assert.equal(row.session_id, 's1');
  assert.equal(row.user_id, 'mike');
  assert.equal(_captureSegmentCount(), 0, 'segment cleared after flush');
});

test('voice: token opens segment, agent transcripts fill it, agent session-end flushes', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  recordVoiceSessionStart(d, { userId: 'mike', devMode: true });
  // Periodic saves from the LiveKit agent — no flush yet.
  recordVoiceTranscript(d, { userId: 'mike', sessionId: 'v1', messages: MSGS.slice(0, 2), isSessionEnd: false });
  assert.equal(supabase.inserted.length, 0);

  // The agent's close-time final transcript — a server-side signal.
  await recordVoiceTranscript(d, { userId: 'mike', sessionId: 'v1', messages: MSGS, isSessionEnd: true });

  assert.equal(anthropic.calls.length, 1);
  assert.equal(supabase.inserted.length, 1);
  assert.equal(supabase.inserted[0].session_id, 'v1');
  assert.equal(_captureSegmentCount(), 0);
});

test('voice: /context/analyze traffic without an open dev segment is ignored', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  await recordVoiceTranscript(d, { userId: 'normal-user', sessionId: 'v9', messages: MSGS, isSessionEnd: true });
  await recordVoiceTranscript(d, { userId: 'normal-user', sessionId: 'v9', messages: MSGS, isSessionEnd: true, devMode: false });
  assert.equal(anthropic.calls.length, 0);
  assert.equal(supabase.inserted.length, 0);
  assert.equal(_captureSegmentCount(), 0);
});

test('voice: dev-mode session-end with NO open segment still files a request (redeploy recovery)', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  // No recordVoiceSessionStart — the container that opened the segment is
  // gone. The agent's final post is a full snapshot and says devMode=true,
  // which is everything a fresh container needs.
  await recordVoiceTranscript(d, { userId: 'mike', sessionId: 'v3', messages: MSGS, isSessionEnd: true, devMode: true });

  assert.equal(anthropic.calls.length, 1);
  assert.equal(supabase.inserted.length, 1);
  assert.equal(supabase.inserted[0].session_id, 'v3');
  assert.equal(supabase.inserted[0].user_id, 'mike');
  assert.equal(_captureSegmentCount(), 0);
});

test('voice: mid-session dev-mode post rebuilds a segment a redeploy wiped', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  // Periodic (non-end) agent post after a container swap: reopens the
  // segment silently, no flush yet.
  recordVoiceTranscript(d, { userId: 'mike', sessionId: 'v4', messages: MSGS.slice(0, 2), isSessionEnd: false, devMode: true });
  assert.equal(_captureSegmentCount(), 1);
  assert.equal(supabase.inserted.length, 0);

  await recordVoiceTranscript(d, { userId: 'mike', sessionId: 'v4', messages: MSGS, isSessionEnd: true, devMode: true });
  assert.equal(supabase.inserted.length, 1);
  assert.equal(supabase.inserted[0].session_id, 'v4');
  assert.equal(_captureSegmentCount(), 0);
});

test('shutdown: SIGTERM flush drains pending segments before exit', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  recordTextTurn(d, { userId: 'mike', sessionId: 's6', messages: MSGS, devMode: true });
  recordVoiceSessionStart(d, { userId: 'ann', devMode: true });
  recordVoiceTranscript(d, { userId: 'ann', sessionId: 'v6', messages: MSGS, isSessionEnd: false });
  assert.equal(_captureSegmentCount(), 2);

  const exits = [];
  const proc = new EventEmitter();
  const handler = registerShutdownFlush(d, { proc, exit: (code) => exits.push(code) });
  assert.equal(proc.listenerCount('SIGTERM'), 1);
  assert.equal(proc.listenerCount('SIGINT'), 1);

  await handler('SIGTERM');

  assert.equal(supabase.inserted.length, 2, 'both segments flushed on shutdown');
  assert.deepEqual(exits, [0], 'process exits after the flush');
  assert.equal(_captureSegmentCount(), 0);

  // Re-entry (SIGTERM then SIGINT) is a no-op — no double exit.
  await handler('SIGINT');
  assert.deepEqual(exits, [0]);
});

test('shutdown: flushAllSegments with nothing pending resolves empty', async () => {
  const d = deps(fakeAnthropic(), fakeSupabase());
  assert.deepEqual(await flushAllSegments(d), []);
});

test('idle sweep flushes a dev session the user just walked away from', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);
  const t0 = 1_000_000;

  recordTextTurn(d, { userId: 'mike', sessionId: 's2', messages: MSGS, devMode: true }, t0);

  await sweepIdleSegments(d, t0 + 60 * 1000); // 1 min: still live
  assert.equal(supabase.inserted.length, 0);

  await sweepIdleSegments(d, t0 + 11 * 60 * 1000); // past the 10-min idle bar
  assert.equal(supabase.inserted.length, 1);
  assert.equal(supabase.inserted[0].session_id, 's2');

  assert.equal(await sweepIdleSegments(d, t0 + 22 * 60 * 1000), null, 'nothing left to flush');
});

test('toggle-off on the text route also flushes a lingering voice segment', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  recordVoiceSessionStart(d, { userId: 'mike', devMode: true });
  recordVoiceTranscript(d, { userId: 'mike', sessionId: 'v2', messages: MSGS, isSessionEnd: false });

  await recordTextTurn(d, { userId: 'mike', sessionId: 's3', messages: [], devMode: false });
  assert.equal(supabase.inserted.length, 1, 'voice segment flushed by the shared toggle');
  assert.equal(supabase.inserted[0].session_id, 'v2');
});

test('empty or trivial segments never reach the spec model', async () => {
  const anthropic = fakeAnthropic();
  const supabase = fakeSupabase();
  const d = deps(anthropic, supabase);

  recordTextTurn(d, { userId: 'mike', sessionId: 's4', messages: MSGS.slice(0, 1), devMode: true });
  await recordTextTurn(d, { userId: 'mike', sessionId: 's4', messages: MSGS.slice(0, 1), devMode: false });
  assert.equal(anthropic.calls.length, 0);
  assert.equal(supabase.inserted.length, 0);
  assert.equal(_captureSegmentCount(), 0);
});

test('devMode=false traffic with no live segments is a no-op', () => {
  const d = deps(fakeAnthropic(), fakeSupabase());
  assert.equal(recordTextTurn(d, { userId: 'mike', sessionId: 's5', messages: MSGS, devMode: false }), null);
  assert.equal(recordVoiceSessionStart(d, { userId: 'mike', devMode: false }), null);
});
