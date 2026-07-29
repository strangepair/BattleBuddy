/**
 * Agent-facing memory tools (Phase 3, docs/12 PR 4) — the write side of the
 * canonical fact store, shared by the text agent (AGENT_TOOLS in index.js)
 * and the voice agent (agent.py → POST /context/facts/tool).
 *
 * Contract (spec §3.4):
 * - `remember` is a PROPOSAL with high provenance, not a direct write: the
 *   schema requires `user_words` quoting what the user actually said, and it
 *   resolves through the same merge gate as extraction. The agent physically
 *   cannot mint a memory without citing the utterance it came from.
 * - `correct_memory` applies IMMEDIATELY (source user_stated, confidence
 *   confirmed) — a correction the user watches BB acknowledge must never sit
 *   in a queue. The old row survives as superseded; out of the prompt.
 * - `forget` hard-retires the fact and tombstones matching episodic rows.
 *   Raw-transcript redaction deliberately does NOT happen here: an
 *   irreversible bulk edit needs the user's own click on the My Memory
 *   screen (Phase 4), not a model's inference from conversation. Tombstones
 *   are reversible; that is the point.
 * - `lookup_fact` reads the warmed cache; profile-blob fallback while the
 *   two systems dual-run.
 */

import {
  FACT_CATEGORIES, getActiveFactsCached, lookupFact,
  retireFact, supersedeFact, slugifyKey,
} from './factStore.js';
import { runGateCycle } from './factGate.js';
import { tombstoneMemories } from './vectorStore.js';
import { lookupProfileField } from './contextAgent.js';

export const FACT_TOOLS = [
  {
    name: 'remember',
    description: "Save a durable fact the user just stated about themselves — their situation, people, triggers, what works, their reasons, preferences. Use when they share something worth never forgetting; do NOT use for countable events (log_event), passing moods, or your own inferences. The fact is proposed to the memory store and merged in the background; acknowledge naturally ('noted', 'I'll remember that'), never read the mechanics aloud.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['identity', 'quit', 'trigger', 'window', 'routine', 'coping', 'motivation', 'person', 'preference', 'watch'],
          description: 'What kind of fact this is.',
        },
        statement: {
          type: 'string',
          description: "The fact as one plain sentence, in the user's words where possible.",
        },
        user_words: {
          type: 'string',
          description: 'REQUIRED: the verbatim words the user said that this fact comes from. A fact you cannot quote is a fact you may not save.',
        },
      },
      required: ['category', 'statement', 'user_words'],
    },
  },
  {
    name: 'correct_memory',
    description: "The user corrected something you know about them, or said a remembered fact is outdated. Applies immediately. Pass the fact's key (from the memory document or lookup_fact) plus either the corrected statement, or retire=true if it's simply no longer true with no replacement. Acknowledge the fix in the same turn.",
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "The fact key being corrected, e.g. 'trigger.morning-coffee'." },
        new_statement: { type: 'string', description: 'The corrected fact, one plain sentence.' },
        retire: { type: 'boolean', description: 'true = the fact is no longer true and has no replacement.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'forget',
    description: "The user asked you to forget something about them. Retires the fact and stops related past-session memories from surfacing. Confirm back what was forgotten. Use only on an explicit request to forget/delete — for corrections use correct_memory.",
    input_schema: {
      type: 'object',
      properties: {
        key_or_topic: { type: 'string', description: "A fact key ('person.alec') or a short topic phrase ('the divorce')." },
      },
      required: ['key_or_topic'],
    },
  },
  {
    name: 'lookup_fact',
    description: "Look up stored facts about the user that didn't fit in your injected memory document — by key ('quit.reason'), category ('coping'), or slug fragment ('coffee'). If it returns nothing, you don't know it: say so and ask, never guess.",
    input_schema: {
      type: 'object',
      properties: {
        key_or_category: { type: 'string', description: 'Fact key, category name, or slug fragment.' },
      },
      required: ['key_or_category'],
    },
  },
];

export const FACT_TOOL_NAMES = new Set(FACT_TOOLS.map(t => t.name));

/** Distinctive phrase for episodic tombstoning, from a key's slug words. */
export function topicPhraseFromKey(key) {
  const slug = String(key || '').split('.')[1] || '';
  return slug.replace(/-/g, ' ').trim();
}

/**
 * Execute one fact tool. Returns { content: object, is_error?: true } —
 * transport-agnostic so index.js (tool_result) and the voice endpoint (JSON)
 * share it.
 */
export async function executeFactTool(name, input = {}, { userId, client, sessionId = null } = {}) {
  if (name === 'remember') {
    const { category, statement, user_words } = input;
    if (!FACT_CATEGORIES.includes(category)) {
      return { content: { error: `unknown category '${category}'` }, is_error: true };
    }
    if (!statement || !user_words || String(user_words).trim().length < 5) {
      return { content: { error: 'user_words is required — quote what the user actually said' }, is_error: true };
    }
    const proposal = {
      category,
      key: slugifyKey(category, statement),
      value: String(statement),
      detail: null,
      confidence: 'observed',
      source: 'agent_tool',
      evidence: [{ quote: String(user_words).slice(0, 240), session_id: sessionId }],
    };
    // Resolves through the same gate as extraction, off the reply path — the
    // quote is already attached, so grounding passes deterministically.
    runGateCycle(userId, [proposal], [], { client, sessionId })
      .catch(e => console.error('[FactTools] remember gate cycle failed:', e.message));
    return { content: { ok: true, status: 'remembered', category, statement } };
  }

  if (name === 'correct_memory') {
    const { key, new_statement, retire } = input;
    const active = getActiveFactsCached(userId);
    const target = active.find(f => f.key === key);
    if (!target) {
      const near = lookupFact(userId, String(key || '').split('.').pop() || key);
      return {
        content: {
          error: `no active fact with key '${key}'`,
          did_you_mean: near ? near.facts.map(f => f.key) : [],
        },
        is_error: true,
      };
    }
    if (retire === true) {
      const r = await retireFact(userId, key);
      return r.ok
        ? { content: { ok: true, retired: key } }
        : { content: { error: r.error }, is_error: true };
    }
    if (!new_statement) {
      return { content: { error: 'provide new_statement or retire=true' }, is_error: true };
    }
    const inserted = await supersedeFact(userId, key, {
      category: target.category,
      value: String(new_statement),
      detail: target.detail,
      confidence: 'confirmed',
      source: 'user_stated',
      evidence: [{ quote: String(new_statement).slice(0, 240), session_id: sessionId, note: 'user correction' }],
    });
    return inserted
      ? { content: { ok: true, corrected: key, now: inserted.value } }
      : { content: { error: 'correction failed to persist' }, is_error: true };
  }

  if (name === 'forget') {
    const { key_or_topic } = input;
    if (!key_or_topic) return { content: { error: 'key_or_topic required' }, is_error: true };
    const active = getActiveFactsCached(userId);
    const exact = active.find(f => f.key === key_or_topic);

    let phrase;
    let retiredKey = null;
    if (exact) {
      await retireFact(userId, exact.key);
      retiredKey = exact.key;
      phrase = topicPhraseFromKey(exact.key);
    } else {
      const matches = active.filter(f => f.key.includes(String(key_or_topic).toLowerCase()));
      if (matches.length === 1) {
        await retireFact(userId, matches[0].key);
        retiredKey = matches[0].key;
        phrase = topicPhraseFromKey(matches[0].key);
      } else if (matches.length > 1) {
        return {
          content: { error: 'ambiguous — which one?', candidates: matches.map(f => f.key) },
          is_error: true,
        };
      } else {
        phrase = String(key_or_topic).trim();
      }
    }

    // Phrases under 4 chars would tombstone half the store on a substring
    // match — refuse rather than over-forget.
    let tombstoned = 0;
    if (phrase && phrase.length >= 4) {
      tombstoned = await tombstoneMemories(userId, phrase);
    }
    return { content: { ok: true, forgot: retiredKey || phrase, episodic_memories_suppressed: tombstoned } };
  }

  if (name === 'lookup_fact') {
    const { key_or_category } = input;
    const hit = lookupFact(userId, key_or_category);
    if (hit) return { content: { source: 'facts', ...hit } };
    // Dual-run fallback: the old profile blob may still hold long-tail fields.
    const legacy = lookupProfileField(userId, key_or_category);
    if (legacy !== null && legacy !== undefined && !(Array.isArray(legacy) && !legacy.length)) {
      return { content: { source: 'profile', value: legacy } };
    }
    return { content: { found: false, note: "not recorded — say so and ask, don't guess" } };
  }

  return { content: { error: `unknown fact tool: ${name}` }, is_error: true };
}
