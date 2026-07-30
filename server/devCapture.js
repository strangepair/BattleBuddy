// ─── Server-side dev-mode conversation capture ───────────────────────────────
//
// The original capture path (client calls /dev/capture on session end) was
// wired to a screen that no longer exists — the live "One Conversation" screen
// has no session-end event, so dev-mode conversations produced nothing. This
// module makes capture a server concern instead: `devMode` already rides every
// /session/turn (text) and /livekit/token (voice) request, so the server
// accumulates dev-mode turns per user here and flushes them through the same
// spec-generation path (generateProductRequests → dev_build_requests) with no
// client lifecycle event required.
//
// What feeds it:
//   - Text: /session/turn sends the FULL message history each turn, so a
//     segment just keeps the latest snapshot.
//   - Voice: /livekit/token (devMode in hand) opens a segment; the LiveKit
//     agent already posts full transcripts to /context/analyze every ~60s and
//     on call close, and those posts update the segment.
//
// Flush triggers (deliberately not per-turn — one coherent request set per
// dev session, no spam):
//   1. Toggle ON→OFF: the DEV toggle is a single client-level switch, so ANY
//      request arriving with devMode=false while the user has active segments
//      means it was just turned off — the natural "end of dev session".
//   2. Voice session end: the agent's own close-time transcript
//      (isSessionEnd=true) — an agent-side signal, not a client UI event.
//   3. Idle sweep: segments quiet for IDLE_FLUSH_MS flush anyway, covering
//      "toggled on, talked, killed the app".
//
// State is in-memory (same trade-off as devPipeline's PAUSED flag), but a
// redeploy no longer loses the session:
//   - Voice: every agent /context/analyze post carries devMode, so a fresh
//     container REBUILDS the segment from the payload — the agent's transcripts
//     are full snapshots, self-sufficient on their own. The end-of-session
//     post produces a request even when no open segment exists.
//   - Graceful shutdown (SIGTERM/SIGINT — a Railway redeploy) flushes all
//     pending segments before exit via registerShutdownFlush().
// Only a hard kill of a TEXT dev session mid-flight can still drop the tail.

import { generateProductRequests, insertRequests } from './devPipeline.js';

const IDLE_FLUSH_MS = Number(process.env.DEV_CAPTURE_IDLE_MS || 10 * 60 * 1000);
const MAX_MESSAGES = 100; // per-segment snapshot cap
const MAX_FLUSH_ATTEMPTS = 2;

// key `${kind}:${uid}` → { kind, uid, sessionId, messages, lastActivity, attempts }
const segments = new Map();

function uidOf(deps, userId) {
  const raw = userId || 'default';
  return deps?.resolveUserId ? deps.resolveUserId(raw) : String(raw);
}

function meaningful(messages) {
  return Array.isArray(messages)
    && messages.length >= 2
    && messages.some((m) => m?.role === 'user' && String(m.content || '').trim());
}

function snapshot(messages) {
  return (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: String(m.content) }));
}

async function flushSegment(deps, key, note) {
  const seg = segments.get(key);
  if (!seg) return null;
  if (!meaningful(seg.messages)) {
    segments.delete(key);
    return null;
  }
  try {
    const tasks = await generateProductRequests(deps.anthropic, { transcript: seg.messages });
    const rows = await insertRequests(deps.supabase, {
      source: 'transcript',
      userId: seg.uid,
      sessionId: seg.sessionId,
    }, tasks);
    segments.delete(key);
    console.log(`[devCapture] flushed ${key} (${note}): ${seg.messages.length} msgs → ${rows.length} request(s)`);
    return rows;
  } catch (err) {
    seg.attempts = (seg.attempts || 0) + 1;
    console.error(`[devCapture] flush ${key} failed (attempt ${seg.attempts}): ${err.message}`);
    if (seg.attempts >= MAX_FLUSH_ATTEMPTS) segments.delete(key);
    else seg.lastActivity = Date.now(); // retried by a later idle sweep
    return null;
  }
}

// The DEV toggle turned off (any route saw devMode=false while segments were
// live) — flush everything this user accumulated.
function flushAllForUser(deps, uid, note) {
  const flushes = [];
  for (const key of ['text', 'voice'].map((k) => `${k}:${uid}`)) {
    if (segments.has(key)) flushes.push(flushSegment(deps, key, note));
  }
  return flushes.length ? Promise.all(flushes) : null;
}

/**
 * Every /session/turn calls this. devMode=true accumulates; devMode=false
 * flushes any live segments (the ON→OFF transition). Never throws; flush work
 * runs in the background — the returned promise exists for tests.
 */
export function recordTextTurn(deps, { userId, sessionId, messages, devMode }, now = Date.now()) {
  try {
    const uid = uidOf(deps, userId);
    if (devMode !== true) return flushAllForUser(deps, uid, 'toggle-off');
    const key = `text:${uid}`;
    const seg = segments.get(key) || { kind: 'text', uid, attempts: 0 };
    seg.sessionId = sessionId || seg.sessionId || null;
    seg.messages = snapshot(messages);
    seg.lastActivity = now;
    segments.set(key, seg);
    return null;
  } catch (err) {
    console.error('[devCapture] recordTextTurn:', err.message);
    return null;
  }
}

/**
 * Every /livekit/token calls this. devMode=true opens a voice segment (the
 * transcripts arrive later via /context/analyze); devMode=false flushes.
 */
export function recordVoiceSessionStart(deps, { userId, devMode }, now = Date.now()) {
  try {
    const uid = uidOf(deps, userId);
    if (devMode !== true) return flushAllForUser(deps, uid, 'toggle-off');
    const key = `voice:${uid}`;
    const seg = segments.get(key) || { kind: 'voice', uid, sessionId: null, messages: [], attempts: 0 };
    seg.lastActivity = now;
    segments.set(key, seg);
    return null;
  } catch (err) {
    console.error('[devCapture] recordVoiceSessionStart:', err.message);
    return null;
  }
}

/**
 * /context/analyze calls this with whatever the voice agent posted. A user is
 * captured if they have an OPEN voice dev segment, OR the agent itself says
 * devMode=true — the latter rebuilds a segment a redeploy wiped, since every
 * agent post is a full transcript snapshot. Everyone else's analyze traffic is
 * untouched. isSessionEnd (the agent's close-time final transcript) flushes
 * immediately, segment or not.
 */
export function recordVoiceTranscript(deps, { userId, sessionId, messages, isSessionEnd, devMode }, now = Date.now()) {
  try {
    const uid = uidOf(deps, userId);
    const key = `voice:${uid}`;
    let seg = segments.get(key);
    if (!seg) {
      if (devMode !== true) return null;
      seg = { kind: 'voice', uid, sessionId: null, messages: [], attempts: 0 };
      segments.set(key, seg);
    }
    seg.sessionId = sessionId || seg.sessionId || null;
    if (Array.isArray(messages) && messages.length) seg.messages = snapshot(messages);
    seg.lastActivity = now;
    if (isSessionEnd) return flushSegment(deps, key, 'voice-session-end');
    return null;
  } catch (err) {
    console.error('[devCapture] recordVoiceTranscript:', err.message);
    return null;
  }
}

/**
 * Periodic safety net (index.js ticks this every minute): flush segments idle
 * past IDLE_FLUSH_MS — the dev session that ended by the user just leaving.
 */
export function sweepIdleSegments(deps, now = Date.now()) {
  const flushes = [];
  for (const [key, seg] of segments) {
    if (now - seg.lastActivity >= IDLE_FLUSH_MS) flushes.push(flushSegment(deps, key, 'idle'));
  }
  return flushes.length ? Promise.all(flushes) : null;
}

/**
 * Flush every open segment regardless of idle time — the shutdown path.
 */
export function flushAllSegments(deps, note = 'shutdown') {
  const flushes = [];
  for (const key of [...segments.keys()]) flushes.push(flushSegment(deps, key, note));
  return Promise.all(flushes);
}

/**
 * Install SIGTERM/SIGINT handlers that flush pending segments before the
 * process exits, so a graceful redeploy (Railway sends SIGTERM, then waits)
 * doesn't drop an in-flight dev session. Flushing calls the spec model, so the
 * wait is bounded: whatever hasn't flushed when the timeout fires is given up
 * — same as today's behavior, never worse. Returns the handler for tests;
 * `exit` is injectable for the same reason.
 */
export function registerShutdownFlush(deps, {
  signals = ['SIGTERM', 'SIGINT'],
  timeoutMs = Number(process.env.DEV_CAPTURE_SHUTDOWN_FLUSH_MS || 10_000),
  exit = (code) => process.exit(code),
  proc = process,
} = {}) {
  let shuttingDown = false;
  const handler = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const pending = segments.size;
    if (pending) {
      console.log(`[devCapture] ${signal}: flushing ${pending} pending segment(s) before exit`);
      let timer;
      try {
        await Promise.race([
          flushAllSegments(deps, `shutdown:${signal}`),
          new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
      } catch (err) {
        console.error('[devCapture] shutdown flush:', err.message);
      } finally {
        clearTimeout(timer);
      }
    }
    exit(0);
  };
  for (const s of signals) proc.on(s, () => { handler(s); });
  return handler;
}

// ─── test hooks ──────────────────────────────────────────────────────────────
export function _resetCaptureState() { segments.clear(); }
export function _captureSegmentCount() { return segments.size; }
