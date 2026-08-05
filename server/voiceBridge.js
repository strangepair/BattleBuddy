/**
 * Server → voice-agent reply bridge.
 *
 * BattleBuddy had two brains. The mobile client sends every final STT
 * transcript to POST /session/turn, which generates the reply the user reads
 * in the chat; the LiveKit agent ran a second, independent generation over the
 * same turn, and that one never produced audio. Voice transcribed perfectly
 * and answered in silence.
 *
 * This module makes the reply the user reads also the reply the user hears.
 * When /session/turn finishes streaming, the finished text is published into
 * the user's LiveKit room as a `bb.speak` data packet; the agent (agent.py)
 * speaks it through Deepgram TTS and generates nothing itself. One reply, one
 * source, spoken once.
 *
 * Extracted from index.js (where PR #125 first shipped it) so it can be tested
 * — index.js boots a server on import, so nothing inside it is reachable from
 * `node --test`, and an untested bridge is how a silent voice session hides.
 *
 * Keyed on userId, which is the fix that came with the extraction. The first
 * version keyed on the client's sessionId, but the client only sends one once
 * a session exists: tap the speaker before typing anything and `sessionId` is
 * undefined at /livekit/token time, nothing is ever mapped, and that session
 * is silent for its whole life. userId is the one key both sides always have.
 *
 * Entries are dropped at session end and when LiveKit reports the room
 * finished, and expire on their own if neither arrives — a stale entry costs
 * one failed send, which is logged.
 *
 * In-memory, same posture as voiceAgentConfig.js: a mapping only has to
 * outlive one voice session on a single server instance, and a redeploy
 * disconnects the room anyway.
 */

import { randomUUID } from 'crypto';

export const SPEAK_TOPIC = 'bb.speak';

// Longer than a typical session, short enough that a missed room_finished
// webhook can't leave a dead room mapped for the rest of the day.
const ROOM_TTL_MS = 60 * 60 * 1000;

// LiveKit's reliable data channel takes ~15 KB per packet. Replies are capped
// at 1024 output tokens (~4 KB), so this only ever trips on something
// pathological — and a truncated spoken reply beats a dropped one.
const MAX_SPEAK_CHARS = 8000;

const rooms = new Map(); // userId -> { room, expiresAt }

function prune(now) {
  for (const [userId, entry] of rooms) {
    if (entry.expiresAt <= now) rooms.delete(userId);
  }
}

/** Called by /livekit/token: this user is (about to be) live in this room. */
export function noteVoiceRoom(userId, room, now = Date.now()) {
  if (!userId || !room) return;
  prune(now);
  rooms.set(userId, { room, expiresAt: now + ROOM_TTL_MS });
}

/** The room this user is live in, or null. */
export function getVoiceRoom(userId, now = Date.now()) {
  if (!userId) return null;
  const entry = rooms.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    rooms.delete(userId);
    return null;
  }
  return entry.room;
}

/** Called at session end (/context/analyze with isSessionEnd). */
export function clearVoiceRoomForUser(userId) {
  if (userId) rooms.delete(userId);
}

/** Called by the LiveKit room_finished webhook — the session is over. */
export function clearVoiceRoomByName(room) {
  if (!room) return;
  for (const [userId, entry] of rooms) {
    if (entry.room === room) rooms.delete(userId);
  }
}

export function _resetVoiceRooms() {
  rooms.clear();
}

/**
 * Prepare model output for text-to-speech.
 *
 * The reply is written for a chat bubble, so it can carry markdown the chat
 * renders and Deepgram would either read aloud or stumble over. Strip only
 * the syntax — never words — and collapse the whitespace that survives.
 */
export function toSpeakableText(text) {
  if (!text) return '';
  let out = String(text)
    .replace(/```[\s\S]*?```/g, ' ')       // fenced code — unspeakable
    .replace(/`([^`]*)`/g, '$1')            // inline code, keep the words
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')// links, keep the label
    .replace(/[*_~]{1,3}(?=\S)/g, '')       // emphasis openers
    .replace(/(?<=\S)[*_~]{1,3}/g, '')      // emphasis closers
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')     // headings
    .replace(/^\s{0,3}[-•]\s+/gm, '')       // bullets
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (out.length > MAX_SPEAK_CHARS) out = `${out.slice(0, MAX_SPEAK_CHARS)}…`;
  return out;
}

function defaultSend(room, payload) {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    return Promise.reject(new Error('LiveKit not configured'));
  }
  // Imported lazily, matching the other LiveKit call sites in index.js — the
  // SDK is only needed when voice is actually in use.
  return import('livekit-server-sdk').then(({ RoomServiceClient, DataPacket_Kind }) => {
    // RELIABLE is 0; read it off the enum when present so a v3 rename can't
    // silently downgrade this to lossy.
    const kind = (DataPacket_Kind && DataPacket_Kind.RELIABLE !== undefined)
      ? DataPacket_Kind.RELIABLE
      : 0;
    return new RoomServiceClient(url, apiKey, apiSecret).sendData(
      room,
      new TextEncoder().encode(JSON.stringify(payload)),
      kind,
      { topic: SPEAK_TOPIC },
    );
  });
}

/**
 * Speak `text` in the user's live voice room, if there is one.
 *
 * Returns { spoken: false, reason } rather than throwing: the reply has
 * already been streamed to the chat by the time this runs, so a bridge
 * failure must never turn a delivered answer into a failed request. It is
 * loud in the logs instead — a session that reads but doesn't talk is
 * exactly the symptom this replaced.
 *
 * `send` is injectable so the tests exercise the real payload without LiveKit.
 */
export async function speakInVoiceRoom(userId, text, { send = defaultSend, now = Date.now() } = {}) {
  const room = getVoiceRoom(userId, now);
  if (!room) return { spoken: false, reason: 'no_active_room' };

  const speakable = toSpeakableText(text);
  if (!speakable) return { spoken: false, reason: 'empty_text' };

  const payload = { type: 'speak', id: randomUUID(), text: speakable };
  try {
    await send(room, payload);
    console.log(`[Speak] Spoke ${speakable.length} chars to ${room} (user ${userId})`);
    return { spoken: true, room, id: payload.id };
  } catch (err) {
    console.error(`[Speak] FAILED to deliver reply to ${room} (user ${userId}) — voice will be silent this turn:`, err.message);
    return { spoken: false, reason: 'send_failed', error: err.message };
  }
}
