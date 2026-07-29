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
// Hot state is in-memory, but every open segment is mirrored to the volume
// (CONTEXT_STORE_DIR — the same disk the raw transcripts survive on) and
// restored lazily after a container swap. Without this, a redeploy mid dev
// session wiped the segment and the agent's close-time transcript hit "no open
// segment" and was dropped (lost the 2026-07-29 mission-dashboard session).
// The analyze payload carries no devMode flag, so the durable segment marker
// is the ONLY trustworthy signal that a voice session was a dev session —
// flushing every no-segment isSessionEnd transcript would capture ordinary
// users. index.js additionally flushes everything on SIGTERM.

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProductRequests, insertRequests } from './devPipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IDLE_FLUSH_MS = Number(process.env.DEV_CAPTURE_IDLE_MS || 10 * 60 * 1000);
const MAX_MESSAGES = 100; // per-segment snapshot cap
const MAX_FLUSH_ATTEMPTS = 2;

// key `${kind}:${uid}` → { kind, uid, sessionId, messages, lastActivity, attempts }
const segments = new Map();

// ─── Durable segment mirror (survives redeploys) ─────────────────────────────

function persistDir() {
  const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
  return resolve(storeDir, 'dev-capture-segments');
}

function persistPath(key) {
  return resolve(persistDir(), `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

// Mirror writes must never break request handling.
function persistSegment(key, seg) {
  try {
    mkdirSync(persistDir(), { recursive: true });
    writeFileSync(persistPath(key), JSON.stringify({ key, ...seg }));
  } catch (err) {
    console.error(`[devCapture] persist ${key} failed: ${err.message}`);
  }
}

function removePersisted(key) {
  try { unlinkSync(persistPath(key)); } catch {}
}

function dropSegment(key) {
  segments.delete(key);
  removePersisted(key);
}

// Map first; on a miss, restore the segment a previous container mirrored.
function getSegment(key) {
  const live = segments.get(key);
  if (live) return live;
  try {
    const raw = JSON.parse(readFileSync(persistPath(key), 'utf-8'));
    const seg = {
      kind: raw.kind,
      uid: raw.uid,
      sessionId: raw.sessionId || null,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      lastActivity: raw.lastActivity || Date.now(),
      attempts: 0,
    };
    segments.set(key, seg);
    console.log(`[devCapture] restored ${key} from volume (redeploy recovery)`);
    return seg;
  } catch {
    return null;
  }
}

// Pull every mirrored segment into memory (idle sweep + shutdown flush need
// the full set, not just keys some request already touched).
function restoreAllFromDisk() {
  let files = [];
  try { files = readdirSync(persistDir()); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(resolve(persistDir(), f), 'utf-8'));
      if (raw.key && !segments.has(raw.key)) getSegment(raw.key);
    } catch {}
  }
}

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
  const seg = getSegment(key);
  if (!seg) return null;
  if (!meaningful(seg.messages)) {
    dropSegment(key);
    return null;
  }
  try {
    const tasks = await generateProductRequests(deps.anthropic, { transcript: seg.messages });
    const rows = await insertRequests(deps.supabase, {
      source: 'transcript',
      userId: seg.uid,
      sessionId: seg.sessionId,
    }, tasks);
    dropSegment(key);
    console.log(`[devCapture] flushed ${key} (${note}): ${seg.messages.length} msgs → ${rows.length} request(s)`);
    return rows;
  } catch (err) {
    seg.attempts = (seg.attempts || 0) + 1;
    console.error(`[devCapture] flush ${key} failed (attempt ${seg.attempts}): ${err.message}`);
    if (seg.attempts >= MAX_FLUSH_ATTEMPTS) dropSegment(key);
    else seg.lastActivity = Date.now(); // retried by a later idle sweep
    return null;
  }
}

// The DEV toggle turned off (any route saw devMode=false while segments were
// live) — flush everything this user accumulated.
function flushAllForUser(deps, uid, note) {
  const flushes = [];
  for (const key of ['text', 'voice'].map((k) => `${k}:${uid}`)) {
    if (getSegment(key)) flushes.push(flushSegment(deps, key, note));
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
    const seg = getSegment(key) || { kind: 'text', uid, attempts: 0 };
    seg.sessionId = sessionId || seg.sessionId || null;
    seg.messages = snapshot(messages);
    seg.lastActivity = now;
    segments.set(key, seg);
    persistSegment(key, seg);
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
    const seg = getSegment(key) || { kind: 'voice', uid, sessionId: null, messages: [], attempts: 0 };
    seg.lastActivity = now;
    segments.set(key, seg);
    persistSegment(key, seg);
    return null;
  } catch (err) {
    console.error('[devCapture] recordVoiceSessionStart:', err.message);
    return null;
  }
}

/**
 * /context/analyze calls this with whatever the voice agent posted. Only a
 * user with an OPEN voice dev segment is captured — everyone else's analyze
 * traffic is untouched. isSessionEnd (the agent's close-time final transcript)
 * flushes immediately.
 */
export function recordVoiceTranscript(deps, { userId, sessionId, messages, isSessionEnd }, now = Date.now()) {
  try {
    const uid = uidOf(deps, userId);
    const key = `voice:${uid}`;
    // getSegment falls back to the volume mirror, so a segment opened by a
    // previous container (redeploy mid-session) is still found here instead
    // of the transcript being silently dropped.
    const seg = getSegment(key);
    if (!seg) return null;
    seg.sessionId = sessionId || seg.sessionId || null;
    if (Array.isArray(messages) && messages.length) seg.messages = snapshot(messages);
    seg.lastActivity = now;
    if (isSessionEnd) return flushSegment(deps, key, 'voice-session-end');
    persistSegment(key, seg);
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
  // Include segments a previous container mirrored to the volume — covers
  // "redeploy, then the user never came back" (no request ever touches the
  // segment again, so lazy restore alone would strand it).
  restoreAllFromDisk();
  const flushes = [];
  for (const [key, seg] of segments) {
    if (now - seg.lastActivity >= IDLE_FLUSH_MS) flushes.push(flushSegment(deps, key, 'idle'));
  }
  return flushes.length ? Promise.all(flushes) : null;
}

/**
 * SIGTERM path (index.js): Railway redeploys send SIGTERM before swapping the
 * container — flush everything still open. Anything that doesn't finish inside
 * the grace period stays mirrored on the volume for the next container.
 */
export function flushAllSegments(deps, note = 'shutdown') {
  restoreAllFromDisk();
  const flushes = [...segments.keys()].map((key) => flushSegment(deps, key, note));
  return flushes.length ? Promise.all(flushes) : null;
}

// ─── test hooks ──────────────────────────────────────────────────────────────
// memoryOnly simulates a container swap: the Map dies, the volume survives.
export function _resetCaptureState({ memoryOnly = false } = {}) {
  segments.clear();
  if (!memoryOnly) {
    try { rmSync(persistDir(), { recursive: true, force: true }); } catch {}
  }
}
export function _captureSegmentCount() { return segments.size; }
