/**
 * Vector Store — Postgres pgvector-backed semantic memory for BattleBuddy.
 *
 * Stores observations, triggers, session summaries, and insights into a
 * Supabase `user_memories` table, embedded via server/embeddings.js
 * (self-hosted, in-process — see that file for why). Retrieval ranks by
 * cosine similarity (match_user_memories RPC) instead of keyword overlap,
 * so a query surfaces memories that resemble it in meaning, not just ones
 * sharing literal words.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import WebSocket from 'ws';
import { resolveUserId } from './contextAgent.js';
import { embed } from './embeddings.js';
import { deriveConceptTags } from './conceptTags.js';

let supabase = null;
let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    // Node 20 has no native WebSocket global; supabase-js's realtime client
    // requires one at construction even though we only use REST/RPC calls.
    // Without this, createClient throws and the vector store is dead for the
    // life of the process (initialized=true, supabase=null).
    supabase = createClient(supabaseUrl, supabaseKey, {
      realtime: { transport: WebSocket },
    });
  }
}

/**
 * Store a piece of content for a user.
 * @param {string} userId
 * @param {string} content - The text to store
 * @param {string} type - 'observation' | 'trigger' | 'session_summary' | 'insight'
 * @param {string} [sessionId] - Optional session identifier
 */
export async function embedAndStore(userId, content, type, sessionId = null) {
  init();
  if (!supabase) return;
  if (!content || content.length < 10) return;

  // Canonicalize here, not at each call site — a caller that forgets to
  // resolve aliases silently writes memories under an ID retrieveRelevant()
  // will never query for again. See the removed /admin/backfill-transcripts
  // endpoint, which did exactly that.
  const canonicalUserId = resolveUserId(userId);

  try {
    const embedding = await embed(content);
    const { error } = await supabase.from('user_memories').insert({
      user_id: canonicalUserId,
      content,
      type,
      embedding,
      // Tagged at write time so the promotion scorer has the signal. Rows
      // written before migration 010 have none and score 0 on that component —
      // worth at most 0.06, so they are not locked out of promotion.
      concept_tags: deriveConceptTags(content),
    });
    if (error) {
      console.error('[VectorStore] Insert failed:', error.message);
    } else {
      console.log(`[VectorStore] Stored ${type} for ${canonicalUserId} (${content.length} chars)`);
    }
  } catch (err) {
    console.error('[VectorStore] Store failed:', err.message);
  }
}

/**
 * Retrieve the most relevant stored memories for a user given a query.
 * @param {string} userId
 * @param {string} queryText - Current context to match against
 * @param {number} [limit=10]
 * @returns {Array<{content: string, type: string, similarity: number, created_at: string}>}
 */
export async function retrieveRelevant(userId, queryText, limit = 10) {
  init();
  if (!supabase) return [];
  if (!queryText || queryText.length < 3) return [];

  const canonicalUserId = resolveUserId(userId);

  try {
    const queryEmbedding = await embed(queryText);
    const { data, error } = await supabase.rpc('match_user_memories', {
      match_user_id: canonicalUserId,
      query_embedding: queryEmbedding,
      match_count: limit,
    });

    if (error) {
      if (error.message.includes('relation') && error.message.includes('does not exist')) {
        console.log('[VectorStore] user_memories table not yet created, returning empty');
        return [];
      }
      console.error('[VectorStore] Retrieval failed:', error.message);
      return [];
    }

    console.log(`[VectorStore] Retrieved ${data?.length || 0} memories for ${canonicalUserId}`);
    return data || [];
  } catch (err) {
    console.error('[VectorStore] Retrieve failed:', err.message);
    return [];
  }
}

/**
 * Fetch this user's promoted memories — the always-injected tier.
 *
 * No query and no embedding: these are the memories that earned a permanent
 * place in context, so this is a plain indexed select. That is the whole point
 * at session start, where retrieveRelevant has nothing to work with because the
 * user hasn't said anything yet. See migrations/009_memory_promotion.sql.
 *
 * @param {string} userId
 * @param {number} [limit=8] - kept small; this rides in every turn's prompt
 * @returns {Array<{content: string, type: string, created_at: string, promoted_at: string}>}
 */
export async function getPromotedMemories(userId, limit = 8) {
  init();
  if (!supabase) return [];

  const canonicalUserId = resolveUserId(userId);

  try {
    const { data, error } = await supabase
      .from('user_memories')
      .select('content, type, created_at, promoted_at')
      .eq('user_id', canonicalUserId)
      .eq('promoted', true)
      .order('promoted_at', { ascending: false })
      .limit(limit);

    if (error) {
      // Missing column means migration 009 hasn't been applied to this
      // environment yet. Deploy order shouldn't be a runtime error — degrade to
      // the same empty result a user with nothing promoted would get.
      if (error.message.includes('promoted')) {
        console.log('[VectorStore] promoted column absent (migration 009 not applied) — skipping tier');
        return [];
      }
      console.error('[VectorStore] Promoted fetch failed:', error.message);
      return [];
    }

    console.log(`[VectorStore] ${data?.length || 0} promoted memories for ${canonicalUserId}`);
    return data || [];
  } catch (err) {
    console.error('[VectorStore] Promoted fetch failed:', err.message);
    return [];
  }
}

/**
 * The dedupe key for one retrieval: '<local YYYY-MM-DD>:<query hash>'.
 *
 * Local date, not UTC — late-night sessions are common here, and an 11pm
 * Central session falling into "tomorrow" in UTC would split one evening across
 * two days, inflating exactly the spacing signal the scorer relies on.
 *
 * The query is hashed, not stored: this table already holds addiction and
 * health content, and there is no reason for the recall trail to hold verbatim
 * user text too.
 */
function buildRecallKey(queryText, timezone) {
  let day;
  try {
    // en-CA renders as YYYY-MM-DD.
    day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'America/Chicago' }).format(new Date());
  } catch {
    day = new Date().toISOString().slice(0, 10);
  }
  const hash = createHash('sha1').update(queryText || '').digest('hex').slice(0, 12);
  return `${day}:${hash}`;
}

/**
 * Record that these memories were retrieved and used in a turn.
 *
 * Retrieval frequency is the evidence the promotion sweep scores on — see
 * migrations/010_memory_recall_signals.sql. Call fire-and-forget: this runs
 * after the reply is already streaming, and a failure here costs a promotion
 * signal, never a turn.
 *
 * @param {Array<{id: string, similarity: number}>} memories - as returned by retrieveRelevant
 */
export async function recordRecalls(memories, queryText, timezone) {
  init();
  if (!supabase || !memories?.length) return;

  const withIds = memories.filter(m => m.id);
  if (!withIds.length) return;

  try {
    const { error } = await supabase.rpc('record_memory_recalls', {
      memory_ids: withIds.map(m => m.id),
      similarities: withIds.map(m => (typeof m.similarity === 'number' ? m.similarity : 0)),
      recall_key: buildRecallKey(queryText, timezone),
    });
    // Missing function means migration 010 hasn't been applied here yet. Log
    // once at info level rather than erroring — recall signal is optional until
    // the sweep is live.
    if (error) {
      if (error.message.includes('record_memory_recalls')) {
        console.log('[VectorStore] record_memory_recalls absent (migration 010 not applied)');
      } else {
        console.error('[VectorStore] Recall recording failed:', error.message);
      }
    }
  } catch (err) {
    console.error('[VectorStore] Recall recording failed:', err.message);
  }
}

/**
 * Memories with enough recall evidence to be worth scoring, across all users.
 *
 * Takes the threshold as an argument rather than importing PROMOTION_GATES —
 * promotionJob imports this module, and reaching back the other way would make
 * a cycle.
 */
export async function getPromotionCandidates(minRecallCount = 3) {
  init();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('user_memories')
      .select('id, user_id, content, recall_count, total_score, recall_keys, concept_tags, last_recalled_at, promoted')
      .gte('recall_count', minRecallCount);

    if (error) {
      console.error('[VectorStore] Promotion candidate fetch failed:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[VectorStore] Promotion candidate fetch failed:', err.message);
    return [];
  }
}

/**
 * Move memories into the always-injected tier.
 */
export async function markPromoted(ids) {
  init();
  if (!supabase || !ids?.length) return 0;

  try {
    const { error } = await supabase
      .from('user_memories')
      .update({ promoted: true, promoted_at: new Date().toISOString() })
      .in('id', ids);

    if (error) {
      console.error('[VectorStore] Promotion write failed:', error.message);
      return 0;
    }
    return ids.length;
  } catch (err) {
    console.error('[VectorStore] Promotion write failed:', err.message);
    return 0;
  }
}

/**
 * Check if the vector store is configured and ready.
 */
export function isConfigured() {
  init();
  return !!supabase;
}
