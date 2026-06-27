/**
 * Vector Store — Postgres full-text-search-backed memory for BattleBuddy.
 *
 * Stores observations, triggers, session summaries, and insights into a
 * Supabase `user_memories` table. Retrieval uses ts_rank over a GIN-indexed
 * tsvector column — no external embedding service required.
 */

import { createClient } from '@supabase/supabase-js';

let supabase = null;
let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
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

  try {
    const { error } = await supabase.from('user_memories').insert({
      user_id: userId,
      content,
      type,
    });
    if (error) {
      console.error('[VectorStore] Insert failed:', error.message);
    } else {
      console.log(`[VectorStore] Stored ${type} for ${userId} (${content.length} chars)`);
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

  try {
    const { data, error } = await supabase.rpc('match_user_memories', {
      match_user_id: userId,
      query_text: queryText,
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

    console.log(`[VectorStore] Retrieved ${data?.length || 0} memories for ${userId}`);
    return data || [];
  } catch (err) {
    console.error('[VectorStore] Retrieve failed:', err.message);
    return [];
  }
}

/**
 * Check if the vector store is configured and ready.
 */
export function isConfigured() {
  init();
  return !!supabase;
}
