// Voice-agent session config store.
//
// Why this exists: LiveKit caps agent-dispatch metadata at 64 KiB, and the
// rendered BattleBuddy system prompt is ~150 KB. Shipping the prompt inside
// createDispatch() metadata made the dispatch request fail — silently, because
// the caller logged it as "may already exist" — so the named agent never
// joined the room and voice sessions connected but never spoke.
//
// Instead, /livekit/token stores the full config here keyed by room name and
// mints a random nonce; only the nonce (plus small identity fields) rides in
// the dispatch metadata. The agent presents {room, token} to
// POST /livekit/agent-config and gets the prompt back over the same HTTP
// channel it already uses for /context/*.
//
// In-memory on purpose (single server instance, same posture as devMode's
// pause flag): a config only needs to survive the seconds between dispatch
// and the agent's job starting. Entries are re-readable within the TTL so an
// agent retry or job restart still finds its config.

import { timingSafeEqual } from 'crypto';

const TTL_MS = 10 * 60 * 1000;

const configs = new Map(); // room -> { token, config, expiresAt }

function prune(now) {
  for (const [room, entry] of configs) {
    if (entry.expiresAt <= now) configs.delete(room);
  }
}

function tokensMatch(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function storeVoiceAgentConfig(room, token, config, now = Date.now()) {
  prune(now);
  configs.set(room, { token, config, expiresAt: now + TTL_MS });
}

export function takeVoiceAgentConfig(room, token, now = Date.now()) {
  prune(now);
  const entry = configs.get(room);
  if (!entry || !token || !tokensMatch(entry.token, token)) return null;
  return entry.config;
}

export function _resetVoiceAgentConfigs() {
  configs.clear();
}
