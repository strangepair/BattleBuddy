/**
 * Fact Store — reads and writes for the canonical `user_facts` layer.
 *
 * One row per fact, one active truth per key (partial unique index in
 * migration 013), superseded in place, never competing actives. This module
 * is the only code that touches user_facts — the write discipline
 * (gate verdicts, precedence) lives in factGate.js and calls in here; the
 * rendering lives in memoryDoc.js and reads from here.
 *
 * Design: docs/11-MEMORY-ARCHITECTURE.md §3.2; plan: docs/12-MEMORY-IMPL-PLAN.md.
 *
 * Pure helpers (slugs, horizons) are exported separately so they test without
 * a database, same split as promotionJob.js.
 */

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { resolveUserId } from './contextAgent.js';

let supabase = null;
let initialized = false;
let absenceLogged = false;

function init() {
  if (initialized) return;
  initialized = true;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) {
    // Node 20 has no native WebSocket global; supabase-js requires one at
    // construction even though only REST calls are used (see vectorStore.js).
    supabase = createClient(url, key, { realtime: { transport: WebSocket } });
  }
}

/** Missing-table errors degrade to empty results: deploy order must not be a
 * runtime error (same contract as getPromotedMemories / migration 009). */
function tableAbsent(error) {
  const msg = error?.message || '';
  if (msg.includes('user_facts') && (msg.includes('does not exist') || msg.includes('relation'))) {
    if (!absenceLogged) {
      absenceLogged = true;
      console.log('[FactStore] user_facts absent (migration 013 not applied) — running empty');
    }
    return true;
  }
  return false;
}

export function isConfigured() {
  init();
  return !!supabase;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

export const FACT_CATEGORIES = [
  'identity', 'quit', 'trigger', 'window', 'routine', 'coping',
  'motivation', 'person', 'preference', 'watch',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Staleness horizons in days, per spec §3.2. Key-level overrides first, then
 * category defaults; null = durable (their reason, their people never expire).
 */
export const REVIEW_HORIZONS = {
  keys: {
    'identity.occupation': 90,
    'identity.location': 90,
    'quit.usage': 14,
    'quit.approach': 30,
  },
  categories: {
    identity: null,
    quit: null,
    trigger: 60,
    window: 45,
    routine: 45,
    coping: 60,
    motivation: null,
    person: null,
    preference: null,
    watch: 30,
  },
};

/** ISO review_after for a fact, or null for durable. */
export function reviewAfterFor(category, key, nowMs = Date.now()) {
  const days = key in REVIEW_HORIZONS.keys
    ? REVIEW_HORIZONS.keys[key]
    : REVIEW_HORIZONS.categories[category];
  if (days === null || days === undefined) return null;
  return new Date(nowMs + days * DAY_MS).toISOString();
}

export const KEY_PATTERN = /^[a-z]+\.[a-z0-9][a-z0-9-]{0,62}$/;

/** 'trigger' + 'Morning coffee on the porch' → 'trigger.morning-coffee-on-the'.
 * First few words, kebab-cased — a normalization, not a hash: near-identical
 * statements land on the same key, which is the point. */
export function slugifyKey(category, text, maxWords = 4) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
  return `${category}.${slug || 'unnamed'}`;
}

/** Suffix a colliding key with -2, -3, … against a Set of existing keys. */
export function ensureUniqueKey(existingKeys, key) {
  if (!existingKeys.has(key)) return key;
  for (let n = 2; n < 100; n++) {
    const candidate = `${key}-${n}`;
    if (!existingKeys.has(candidate)) return candidate;
  }
  return `${key}-${Date.now() % 100000}`;
}

/** Second independent sighting (a different session) upgrades tentative →
 * observed: repetition becomes confidence, not clutter (spec §3.5 DUPLICATE). */
export function shouldUpgradeConfidence(fact, newEvidence) {
  if (fact.confidence !== 'tentative') return false;
  const sessions = new Set(
    (Array.isArray(fact.evidence) ? fact.evidence : [])
      .map(e => e?.session_id)
      .filter(Boolean)
  );
  return !!newEvidence?.session_id && sessions.size > 0 && !sessions.has(newEvidence.session_id);
}

// ─── In-process cache of active facts ───────────────────────────────────────
// Same rationale as contextAgent's profile cache: the prompt path needs a
// synchronous read. All user_facts writes go through this module in this
// process, so refreshing after each write keeps it coherent.

const activeCache = new Map(); // canonical userId -> fact rows (status='active')

async function refreshCache(userId) {
  const facts = await fetchActiveFacts(userId);
  activeCache.set(userId, facts);
  return facts;
}

/** Sync read for prompt-building. Empty array until warmed. */
export function getActiveFactsCached(rawUserId) {
  return activeCache.get(resolveUserId(rawUserId)) || [];
}

/** Boot-time warm across all users with facts (fire-and-forget from index.js). */
export async function warmFactCache() {
  init();
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase
      .from('user_facts')
      .select('*')
      .eq('status', 'active');
    if (error) {
      if (!tableAbsent(error)) console.error('[FactStore] Warm failed:', error.message);
      return 0;
    }
    const byUser = new Map();
    for (const row of data || []) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }
    for (const [userId, facts] of byUser) activeCache.set(userId, facts);
    console.log(`[FactStore] Warmed ${data?.length || 0} active fact(s) for ${byUser.size} user(s)`);
    return data?.length || 0;
  } catch (err) {
    console.error('[FactStore] Warm failed:', err.message);
    return 0;
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────

async function fetchActiveFacts(userId) {
  init();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('user_facts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('category')
      .order('key');
    if (error) {
      if (!tableAbsent(error)) console.error('[FactStore] Active fetch failed:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[FactStore] Active fetch failed:', err.message);
    return [];
  }
}

export async function getActiveFacts(rawUserId) {
  const userId = resolveUserId(rawUserId);
  return refreshCache(userId);
}

export async function getFactsByStatus(rawUserId, status) {
  init();
  if (!supabase) return [];
  const userId = resolveUserId(rawUserId);
  try {
    const { data, error } = await supabase
      .from('user_facts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', status)
      .order('category')
      .order('key');
    if (error) {
      if (!tableAbsent(error)) console.error('[FactStore] Status fetch failed:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[FactStore] Status fetch failed:', err.message);
    return [];
  }
}

/** All keys currently in use for a user (any non-rejected status) — the list
 * the gate assigns new keys against. */
export async function listKeys(rawUserId) {
  init();
  if (!supabase) return new Set();
  const userId = resolveUserId(rawUserId);
  try {
    const { data, error } = await supabase
      .from('user_facts')
      .select('key')
      .eq('user_id', userId)
      .neq('status', 'rejected');
    if (error) return new Set();
    return new Set((data || []).map(r => r.key));
  } catch {
    return new Set();
  }
}

/** Distinct user ids holding any active facts (consolidation sweep scope). */
export async function listFactUsers() {
  init();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('user_facts')
      .select('user_id')
      .eq('status', 'active');
    if (error) return [];
    return [...new Set((data || []).map(r => r.user_id))];
  } catch {
    return [];
  }
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Insert one fact row. status defaults to 'proposed' — activation is a
 * separate, deliberate step (gate verdict, admin review, or user action).
 * review_after computed from the horizon table unless explicitly provided.
 */
export async function insertFact(rawUserId, fact) {
  init();
  if (!supabase) return null;
  const userId = resolveUserId(rawUserId);

  if (!FACT_CATEGORIES.includes(fact.category)) {
    console.error(`[FactStore] Rejected insert — unknown category '${fact.category}'`);
    return null;
  }
  if (!KEY_PATTERN.test(fact.key) || !fact.key.startsWith(`${fact.category}.`)) {
    console.error(`[FactStore] Rejected insert — malformed key '${fact.key}'`);
    return null;
  }

  const row = {
    user_id: userId,
    category: fact.category,
    key: fact.key,
    value: fact.value,
    detail: fact.detail || null,
    status: fact.status || 'proposed',
    confidence: fact.confidence || 'tentative',
    source: fact.source,
    evidence: Array.isArray(fact.evidence) ? fact.evidence : [],
    conflict_with: fact.conflict_with || null,
    review_after: fact.review_after !== undefined
      ? fact.review_after
      : reviewAfterFor(fact.category, fact.key),
  };

  try {
    const { data, error } = await supabase.from('user_facts').insert(row).select('*').single();
    if (error) {
      if (!tableAbsent(error)) console.error('[FactStore] Insert failed:', error.message);
      return null;
    }
    if (row.status === 'active') await refreshCache(userId);
    return data;
  } catch (err) {
    console.error('[FactStore] Insert failed:', err.message);
    return null;
  }
}

/** Flip a proposed row to active (admin review / gate NEW verdict). Fails
 * cleanly if an active row already holds the key (unique index) — the caller
 * should route that through supersedeFact instead. */
export async function activateFact(rawUserId, id) {
  init();
  if (!supabase) return { ok: false, error: 'not configured' };
  const userId = resolveUserId(rawUserId);
  try {
    const { error } = await supabase
      .from('user_facts')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'proposed');
    if (error) return { ok: false, error: error.message };
    await refreshCache(userId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function rejectFact(rawUserId, id) {
  init();
  if (!supabase) return { ok: false, error: 'not configured' };
  const userId = resolveUserId(rawUserId);
  try {
    const { error } = await supabase
      .from('user_facts')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'proposed');
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Same subject, new truth: mark the current active row for `key` superseded
 * (chain linked via superseded_by), then insert the successor as active.
 * History is kept, but out of the prompt.
 */
export async function supersedeFact(rawUserId, key, newFact) {
  init();
  if (!supabase) return null;
  const userId = resolveUserId(rawUserId);
  try {
    const { data: existing } = await supabase
      .from('user_facts')
      .select('id')
      .eq('user_id', userId)
      .eq('key', key)
      .eq('status', 'active')
      .maybeSingle();

    const inserted = await insertFact(userId, { ...newFact, key: newFact.key || key, status: 'active' });
    if (!inserted) return null;

    if (existing) {
      // Old row steps down only after the successor is safely in. Note the
      // successor uses its own key if changed; the unique index only bites on
      // same-key same-status, which the update below clears.
      const { error } = await supabase
        .from('user_facts')
        .update({ status: 'superseded', superseded_by: inserted.id, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) console.error('[FactStore] Supersede link failed:', error.message);
    }
    await refreshCache(userId);
    return inserted;
  } catch (err) {
    console.error('[FactStore] Supersede failed:', err.message);
    return null;
  }
}

/** Retire with no successor (user said it's no longer true / forget). */
export async function retireFact(rawUserId, key) {
  init();
  if (!supabase) return { ok: false, error: 'not configured' };
  const userId = resolveUserId(rawUserId);
  try {
    const { data, error } = await supabase
      .from('user_facts')
      .update({ status: 'retired', updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('key', key)
      .eq('status', 'active')
      .select('id');
    if (error) return { ok: false, error: error.message };
    await refreshCache(userId);
    return { ok: true, retired: (data || []).length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** User confirmed the fact still holds: confidence → confirmed, staleness
 * horizon refreshed from now. */
export async function confirmFact(rawUserId, key, nowMs = Date.now()) {
  init();
  if (!supabase) return { ok: false, error: 'not configured' };
  const userId = resolveUserId(rawUserId);
  try {
    const { data: rows } = await supabase
      .from('user_facts')
      .select('id, category')
      .eq('user_id', userId)
      .eq('key', key)
      .eq('status', 'active')
      .limit(1);
    const row = rows && rows[0];
    if (!row) return { ok: false, error: 'no active fact for key' };
    const { error } = await supabase
      .from('user_facts')
      .update({
        confidence: 'confirmed',
        review_after: reviewAfterFor(row.category, key, nowMs),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (error) return { ok: false, error: error.message };
    await refreshCache(userId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * DUPLICATE verdict: strengthen instead of append — evidence grows,
 * tentative → observed on a second independent sighting, staleness refreshed.
 */
export async function strengthenFact(rawUserId, key, evidenceEntry, nowMs = Date.now()) {
  init();
  if (!supabase) return { ok: false, error: 'not configured' };
  const userId = resolveUserId(rawUserId);
  try {
    const { data: rows } = await supabase
      .from('user_facts')
      .select('id, category, confidence, evidence')
      .eq('user_id', userId)
      .eq('key', key)
      .eq('status', 'active')
      .limit(1);
    const row = rows && rows[0];
    if (!row) return { ok: false, error: 'no active fact for key' };

    const evidence = Array.isArray(row.evidence) ? [...row.evidence] : [];
    if (evidenceEntry) evidence.push(evidenceEntry);
    const updates = {
      evidence: evidence.slice(-20),
      review_after: reviewAfterFor(row.category, key, nowMs),
      updated_at: new Date().toISOString(),
    };
    if (shouldUpgradeConfidence(row, evidenceEntry)) updates.confidence = 'observed';

    const { error } = await supabase.from('user_facts').update(updates).eq('id', row.id);
    if (error) return { ok: false, error: error.message };
    await refreshCache(userId);
    return { ok: true, upgraded: updates.confidence === 'observed' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** CONFLICTS verdict: both facts stay, flagged; the render surfaces the pair
 * and the agent resolves it in conversation. */
export async function flagConflict(rawUserId, idA, idB) {
  init();
  if (!supabase) return { ok: false, error: 'not configured' };
  const userId = resolveUserId(rawUserId);
  try {
    const now = new Date().toISOString();
    const [a, b] = await Promise.all([
      supabase.from('user_facts').update({ conflict_with: idB, updated_at: now }).eq('id', idA).eq('user_id', userId),
      supabase.from('user_facts').update({ conflict_with: idA, updated_at: now }).eq('id', idB).eq('user_id', userId),
    ]);
    const error = a.error || b.error;
    if (error) return { ok: false, error: error.message };
    await refreshCache(userId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
