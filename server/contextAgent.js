/**
 * Background Context Agent — runs Sonnet in parallel to extract and maintain
 * a living user profile from the ongoing conversation.
 *
 * Architecture:
 *   Real-time agent (Haiku) ←→ User
 *         ↓ (messages stream in)
 *   Context Agent (Sonnet) — analyzes, extracts facts, updates profile
 *         ↓
 *   Context Store (in-memory, backed by Supabase) — the real-time agent reads this
 *
 * The context agent never touches the conversation. It only observes and writes.
 *
 * Array items are stored as { value: "...", captured_at: "ISO timestamp" }
 * so BB can reference when something was learned: "you mentioned this last Tuesday."
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env so we have the API key
const envPath = resolve(__dirname, '.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1);
    }
  }
} catch {}

const client = new Anthropic();

const STORE_DIR = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');

// ─── Admin console data: resources + behavioral directives ──────────────────
// Lives at the root of the Railway volume (/data), beside context-store, so it
// survives redeploys. Local dev falls back to server/data/ (git-ignored).
export const ADMIN_DATA_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || resolve(__dirname, 'data');
export const RESOURCES_DIR = resolve(ADMIN_DATA_ROOT, 'resources');
export const DIRECTIVES_PATH = resolve(ADMIN_DATA_ROOT, 'directives.json');

export function loadDirectives() {
  try {
    const list = JSON.parse(readFileSync(DIRECTIVES_PATH, 'utf-8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** A date-only expiry ("2026-07-15") keeps the directive active through the
 * end of that day in the user's timezone — Railway runs UTC, and a directive
 * expiring "today" must not die at 7 PM Central. No expiry = always active. */
export function isDirectiveActive(directive, timezone = 'America/Chicago') {
  if (!directive || !directive.expires) return true;
  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return String(directive.expires) >= today;
  } catch {
    return true;
  }
}

// ─── Prompt store: live-edit persistence across deploys ─────────────────────
// The system prompt file ships inside the (ephemeral) container image. Writers
// at runtime — the admin console and the in-process design loop — mirror their
// edits to the volume; on boot the edit is restored IF the image still ships
// the same prompt it was based on. If a deploy ships a DIFFERENT prompt (a dev
// commit), the repo wins and the runtime edit is archived, never silently lost.

export const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts', 'system.battlebuddy.md');
const PROMPT_LIVE_DIR = resolve(ADMIN_DATA_ROOT, 'prompt-live');
const PROMPT_LIVE_PATH = resolve(PROMPT_LIVE_DIR, 'system.battlebuddy.md');
const PROMPT_LIVE_META = resolve(PROMPT_LIVE_DIR, 'meta.json');
const PROMPT_BACKUPS_DIR = resolve(ADMIN_DATA_ROOT, 'prompt-backups');
const MAX_PROMPT_BACKUPS = 20;

const sha256 = s => createHash('sha256').update(s).digest('hex');

// Hash of the prompt as shipped in this image — captured at import time,
// before any restore touches the file.
export const bundledPromptHash = (() => {
  try { return sha256(readFileSync(SYSTEM_PROMPT_PATH, 'utf-8')); } catch { return null; }
})();

export function promptDivergedFromRepo(content) {
  return !!bundledPromptHash && sha256(content) !== bundledPromptHash;
}

/** Timestamped copy of the current prompt onto the volume before every
 * overwrite, pruned to the newest MAX_PROMPT_BACKUPS. */
export function backupPromptToVolume() {
  mkdirSync(PROMPT_BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeFileSync(resolve(PROMPT_BACKUPS_DIR, `system.battlebuddy.${stamp}.md`), readFileSync(SYSTEM_PROMPT_PATH, 'utf-8'));
  const backups = readdirSync(PROMPT_BACKUPS_DIR).filter(f => f.endsWith('.md')).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - MAX_PROMPT_BACKUPS))) {
    try { unlinkSync(resolve(PROMPT_BACKUPS_DIR, old)); } catch {}
  }
}

/** Write a new prompt: container file (hot-reloads on the next turn) plus the
 * volume mirror + provenance meta so it survives redeploys. */
export function persistPromptLive(content) {
  backupPromptToVolume();
  writeFileSync(SYSTEM_PROMPT_PATH, content);
  mkdirSync(PROMPT_LIVE_DIR, { recursive: true });
  writeFileSync(PROMPT_LIVE_PATH, content);
  writeFileSync(PROMPT_LIVE_META, JSON.stringify({ savedAt: new Date().toISOString(), bundledHash: bundledPromptHash }, null, 2));
}

(function restoreLiveEditOnBoot() {
  try {
    if (!existsSync(PROMPT_LIVE_PATH) || !existsSync(PROMPT_LIVE_META)) return;
    const meta = JSON.parse(readFileSync(PROMPT_LIVE_META, 'utf-8'));
    const saved = readFileSync(PROMPT_LIVE_PATH, 'utf-8');
    if (meta.bundledHash === bundledPromptHash) {
      if (sha256(saved) !== bundledPromptHash) {
        writeFileSync(SYSTEM_PROMPT_PATH, saved);
        console.log(`[PromptStore] Restored runtime-edited prompt from volume (saved ${meta.savedAt})`);
      }
    } else {
      const stamp = String(meta.savedAt || new Date().toISOString()).replace(/[:.]/g, '-');
      writeFileSync(resolve(PROMPT_LIVE_DIR, `superseded-${stamp}.md`), saved);
      unlinkSync(PROMPT_LIVE_PATH);
      unlinkSync(PROMPT_LIVE_META);
      console.warn(`[PromptStore] Deploy shipped a newer prompt — repo version wins; runtime edit archived as superseded-${stamp}.md`);
    }
  } catch (e) {
    console.warn('[PromptStore] Prompt restore skipped:', e.message);
  }
})();

// ─── Insights feedback: the admin's verdicts on past recommendations ────────
// Applied (possibly reworded) and dismissed recommendations are recorded on
// the volume. Beyond hiding them in the console, they're injected into the
// NEXT analysis runs (transcript audit + design loop) so the recommendation
// engines calibrate to what the admin actually finds useful.

export const INSIGHTS_STATE_PATH = resolve(ADMIN_DATA_ROOT, 'insights-state.json');
export const proposalKey = (reportId, proposalText) => `${reportId}#${sha256(String(proposalText)).slice(0, 16)}`;

export function loadInsightsState() {
  try { return JSON.parse(readFileSync(INSIGHTS_STATE_PATH, 'utf-8')); } catch { return { applied: {}, dismissed: {} }; }
}

export function saveInsightsState(state) {
  mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
  writeFileSync(INSIGHTS_STATE_PATH, JSON.stringify(state, null, 2));
}

const stripConfidencePrefix = s => String(s || '').replace(/^\s*(HIGH|MEDIUM|LOW)\s*CONFIDENCE\s*[—:–-]+\s*/i, '').trim();
const clip = (s, n = 300) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

/** Prompt block describing the admin's reactions to past recommendations, or
 * null when there's no history yet. Injected into the analysis prompts. */
export function buildInsightsFeedback(limit = 10) {
  const st = loadInsightsState();
  const byNewest = k => Object.values(st[k] || {}).sort((a, b) => String(b.dismissedAt || b.appliedAt || '').localeCompare(String(a.dismissedAt || a.appliedAt || '')));

  const lines = [];
  const dismissed = byNewest('dismissed').slice(0, limit);
  if (dismissed.length) {
    lines.push('Recommendations the admin DISMISSED as not useful — do not re-propose these or close variants; infer what made them miss:');
    for (const d of dismissed) lines.push(`- ${clip(stripConfidencePrefix(d.text))}`);
  }
  const applied = byNewest('applied').slice(0, limit);
  const edited = applied.filter(a => a.original && stripConfidencePrefix(a.original) !== a.text);
  const verbatim = applied.filter(a => !a.original || stripConfidencePrefix(a.original) === a.text);
  if (edited.length) {
    lines.push('Recommendations the admin REWORDED before applying — the rewrite shows what he actually wanted; match that framing and scope in future proposals:');
    for (const a of edited) lines.push(`- PROPOSED: ${clip(stripConfidencePrefix(a.original), 200)}\n  APPLIED AS: ${clip(a.text, 200)}`);
  }
  if (verbatim.length) {
    lines.push('Recommendations the admin applied as-is (these hit the mark):');
    for (const a of verbatim) lines.push(`- ${clip(a.text, 200)}`);
  }
  return lines.length ? lines.join('\n') : null;
}

// Resources are injected whole, so a few oversized pastes could quietly blow
// the prompt budget (latency + cost on every turn). Injection stops once the
// running total passes this; skipped files are logged, and the admin console
// shows per-file sizes so oversized resources are visible.
const RESOURCE_INJECTION_BUDGET = 60000;

/**
 * Build the admin-console prompt injections: active behavioral directives
 * (placed near the top of the system prompt, above the persona) and the
 * resource library (appended at the end). Read fresh on every prompt build —
 * same hot-reload contract as the system prompt file itself.
 */
export function buildAdminInjections() {
  let directivesSection = null;
  const active = loadDirectives().filter(d => isDirectiveActive(d));
  if (active.length > 0) {
    directivesSection = '## Current Directives\n'
      + '(Set by the admin. These override anything below that conflicts with them.)\n'
      + active.map(d => `- ${d.text}${d.expires ? ` (in effect through ${d.expires})` : ''}`).join('\n');
  }

  let resourcesSection = null;
  try {
    const files = readdirSync(RESOURCES_DIR).filter(f => !f.startsWith('.')).sort();
    const parts = [];
    let remaining = RESOURCE_INJECTION_BUDGET;
    for (const file of files) {
      let content = '';
      try { content = readFileSync(resolve(RESOURCES_DIR, file), 'utf-8').trim(); } catch { continue; }
      if (!content) continue;
      if (content.length > remaining) {
        console.warn(`[AdminConsole] Resource "${file}" skipped — over the ${RESOURCE_INJECTION_BUDGET}-char injection budget`);
        continue;
      }
      remaining -= content.length;
      parts.push(`### ${file.replace(/\.[^.]+$/, '')}\n${content}`);
    }
    if (parts.length > 0) {
      resourcesSection = '## Resources\n'
        + '(Reference material added by the admin — research, frameworks, coaching approaches. Draw on these where they fit; never recite them.)\n\n'
        + parts.join('\n\n');
    }
  } catch {} // no resources dir yet — nothing to inject

  return { directivesSection, resourcesSection };
}

/** One-time seed value for voice_preference — the old global voice-config.json,
 * kept on disk but no longer written to once every profile has its own field. */
function readDefaultVoicePreference() {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, 'voice-config.json'), 'utf-8')).voice || 'aura-2-arcas-en';
  } catch {
    return 'aura-2-arcas-en';
  }
}

const profiles = {};

const TIMESTAMPED_ARRAYS = [
  'triggers', 'coping_strategies', 'what_works', 'what_doesnt_work',
  'motivations', 'life_context', 'recent_insights', 'next_session_hints',
  'user_quotes', 'unknowns',
];

const DATED_SCALARS = [
  'daily_usage', 'longest_quit', 'quit_reason', 'health_concerns',
  'family', 'occupation',
];

const LIFE_ARCH_ARRAYS = [
  'trigger_taxonomy', 'flow_state_activities', 'physical_risk_spaces',
  'oral_habit_pairs', 'transition_patterns', 'resistance_strategies',
  'social_contexts',
];

const SCHEDULE_MODEL_ARRAYS = ['routine_blocks', 'vulnerability_windows', 'life_change_watch'];

// Map of user ID aliases — redirects old IDs to the canonical one. This is
// the bootstrap seed / offline fallback; user_aliases in Supabase is the
// live source of truth once warmProfileStoreFromSupabase() below has run
// (it seeds the table from this map on first boot, then merges any rows —
// including ones added later via the admin console — back into this object).
export const USER_ALIASES = {
  'default': 'user-1782351957094',
  'user-1782249813276': 'user-1782351957094',
  // Real Supabase Auth UID for mike@strangepair.com, established 2026-07-07.
  'a4a90d90-e7e9-42dd-abbc-b1033afaf834': 'user-1782351957094',
};

export function resolveUserId(userId) {
  return USER_ALIASES[userId] || userId;
}

/** All alias IDs that redirect to a given canonical ID (reverse lookup on USER_ALIASES). */
function getAliasesFor(canonicalId) {
  return Object.keys(USER_ALIASES).filter(alias => USER_ALIASES[alias] === canonicalId && alias !== canonicalId);
}

// ─── Supabase-backed profile store ──────────────────────────────────────────
// user_profiles is the source of truth; the volume (context-store/*.json,
// read via getStorePath below) is the fallback for migration only — session
// transcripts are unaffected and stay on the volume.
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    realtime: { transport: WebSocket },
  })
  : null;

async function upsertProfileRow(userId, profile) {
  if (!supabase) {
    console.warn(`[ContextAgent] Supabase not configured — profile for ${userId} not persisted`);
    return;
  }
  const { error } = await supabase.from('user_profiles').upsert(
    { user_id: userId, profile, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (error) console.error(`[ContextAgent] Supabase profile save failed for ${userId}:`, error.message);
}

/**
 * Boot-time warm-up: pulls every known profile + alias into memory so the
 * rest of this module can keep reading/writing them synchronously. loadProfile
 * and saveProfile are called from ~20 call sites across this file and
 * index.js, several inside per-turn prompt-building paths — converting all of
 * them to async would risk an unawaited promise leaking "[object Promise]"
 * into a live system prompt. ESM top-level await blocks index.js's import of
 * this module until this resolves, so the in-memory cache already reflects
 * Supabase before the HTTP server starts listening.
 */
async function warmProfileStoreFromSupabase() {
  if (!supabase) {
    console.warn('[ContextAgent] Supabase not configured — profiles will only use the volume fallback');
    return;
  }

  try {
    const { data: rows, error } = await supabase.from('user_profiles').select('user_id, profile');
    if (error) throw error;
    for (const row of rows || []) {
      profiles[row.user_id] = migrateProfile(row.profile || {});
    }
    console.log(`[ContextAgent] Warmed ${rows?.length || 0} profile(s) from Supabase`);
  } catch (e) {
    console.error('[ContextAgent] Failed to warm profiles from Supabase, falling back to volume on demand:', e.message);
  }

  try {
    // Seed the table with the hardcoded map on first boot so future admin
    // edits have somewhere to live; ignored once rows already exist.
    await supabase.from('user_aliases').upsert(
      Object.entries(USER_ALIASES).map(([alias_id, canonical_id]) => ({ alias_id, canonical_id })),
      { onConflict: 'alias_id', ignoreDuplicates: true }
    );
    const { data: aliasRows, error: aliasError } = await supabase.from('user_aliases').select('alias_id, canonical_id');
    if (aliasError) throw aliasError;
    for (const row of aliasRows || []) {
      USER_ALIASES[row.alias_id] = row.canonical_id;
    }
    console.log(`[ContextAgent] Loaded ${aliasRows?.length || 0} alias(es) from Supabase`);
  } catch (e) {
    console.error('[ContextAgent] Failed to sync aliases with Supabase, using hardcoded map only:', e.message);
  }
}

await warmProfileStoreFromSupabase();

function getStorePath(userId) {
  return resolve(STORE_DIR, `${userId}.json`);
}

const TRANSCRIPT_DIR = resolve(STORE_DIR, 'session-transcripts');

/**
 * Persist the full, unmodified conversation transcript to disk — independent of
 * the Sonnet fact-extraction pipeline, so the raw record survives even if
 * extraction fails or the profile schema changes. Overwritten on every call for
 * a given session (the caller always sends the full accumulated message list),
 * so the file is complete as of the most recent save.
 *
 * Plaintext, unencrypted, on the same volume as the profile store — acceptable
 * for now (single-user local build). Revisit before any multi-user rollout.
 */
export function saveRawTranscript(rawUserId, sessionId, messages, isSessionEnd, timezone) {
  if (!messages || !messages.length) return;
  const userId = resolveUserId(rawUserId || 'default');
  const dir = resolve(TRANSCRIPT_DIR, userId);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  const safeSessionId = String(sessionId || 'unknown-session').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = resolve(dir, `${safeSessionId}.json`);

  writeFileSync(filePath, JSON.stringify({
    userId,
    sessionId: safeSessionId,
    timezone: timezone || null,
    isSessionEnd: !!isSessionEnd,
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages,
  }, null, 2));
}

/**
 * Extract the string value from an array item, whether it's a plain string
 * (legacy format) or a { value, captured_at } object (new format).
 */
function itemValue(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && item.value) return item.value;
  return '';
}

/**
 * Safely parse JSON from LLM output. Tries JSON.parse, then jsonrepair,
 * then regex extraction, then jsonrepair on the extracted block.
 * Never throws — returns {} on total failure.
 */
function safeJsonParse(text) {
  // Direct parse
  try { return JSON.parse(text); } catch {}

  // jsonrepair on full text
  try { return JSON.parse(jsonrepair(text)); } catch {}

  // Extract JSON block via regex
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
    try { return JSON.parse(jsonrepair(match[0])); } catch {}
  }

  console.error('[ContextAgent] All JSON parse attempts failed, skipping update');
  return {};
}

/**
 * Migrate a profile from plain-string arrays to timestamped objects.
 * Idempotent — safe to call on already-migrated profiles.
 */
function migrateProfile(profile) {
  if (!profile.voice_preference) profile.voice_preference = readDefaultVoicePreference();
  for (const field of TIMESTAMPED_ARRAYS) {
    if (!Array.isArray(profile[field])) continue;
    profile[field] = profile[field].map(item => {
      if (typeof item === 'string') {
        return { value: item, captured_at: profile.last_updated || new Date().toISOString() };
      }
      return item;
    });
  }
  for (const field of DATED_SCALARS) {
    if (profile[field] && !profile[`${field}_updated_at`]) {
      profile[`${field}_updated_at`] = profile.last_updated || new Date().toISOString();
    }
  }
  if (!Array.isArray(profile.activity_log)) profile.activity_log = [];
  if (!Array.isArray(profile.risk_windows)) profile.risk_windows = [];
  if (!Array.isArray(profile.session_history)) profile.session_history = [];
  backfillSessionHistory(profile);
  // Ensure life_architecture exists
  if (!profile.life_architecture || typeof profile.life_architecture !== 'object') {
    profile.life_architecture = {
      trigger_taxonomy: [],
      flow_state_activities: [],
      physical_risk_spaces: [],
      oral_habit_pairs: [],
      transition_patterns: [],
      urge_model: null,
      resistance_strategies: [],
      social_contexts: [],
    };
  }
  for (const field of LIFE_ARCH_ARRAYS) {
    if (!Array.isArray(profile.life_architecture[field])) {
      profile.life_architecture[field] = [];
    }
  }
  // Ensure schedule_model exists
  if (!profile.schedule_model || typeof profile.schedule_model !== 'object') {
    profile.schedule_model = { routine_blocks: [], vulnerability_windows: [], life_change_watch: [] };
  }
  for (const field of SCHEDULE_MODEL_ARRAYS) {
    if (!Array.isArray(profile.schedule_model[field])) {
      profile.schedule_model[field] = [];
    }
  }
  return profile;
}

/**
 * One-time backfill of session_history from existing profile data.
 * Recovers what it can from life_context session notes and extraction timestamps.
 * Idempotent — skips if session_history already has entries.
 */
function backfillSessionHistory(profile) {
  if (profile.session_history && profile.session_history.length > 0) return;
  if (!profile.session_history) profile.session_history = [];

  // Sessions 1-34: no individual data recoverable
  profile.session_history.push({
    sessions: '1-34',
    date_range: 'before 2026-06-24',
    summary: 'No session-level records exist for these sessions. Profile facts were captured but session dates, topics, and chronology were not tracked.',
    gap: true,
  });

  // Sessions 35-38: recoverable from life_context notes
  profile.session_history.push({
    session: 35,
    date: '2026-06-24',
    summary: 'Memory probe session. Mike opened with Alec/Chantix test — BB failed, said Alec has a prescription when he does not. Mike corrected twice in same exchange. Extremely short, no other topics.',
    key_moments: ['Chantix correction failed again', 'trust erosion on specific detail'],
    mood: 'frustrated',
  });

  profile.session_history.push({
    session: 36,
    date: '2026-06-24',
    summary: 'Memory probe — BB passed. Mike tested Alec/Chantix and Strange Pair recall. First recorded approval of BB memory. Mike began asking about daily routine and quit progress before session cut off.',
    key_moments: ['trust inflection point', 'first memory approval', 'daily routine question raised'],
    mood: 'cautious→satisfied',
  });

  profile.session_history.push({
    session: 37,
    date: '2026-06-24',
    summary: 'Extremely short. BB interrupted Mike mid-sentence on opening memory probe. Mike tried again. BB admitted no transcript but recited profile facts. No substantive content exchanged.',
    key_moments: ['BB interruption failure mode', 'content library reframed as supplemental'],
    mood: 'corrective',
  });

  profile.session_history.push({
    session: 38,
    date: '2026-06-24',
    summary: 'Shortest session on record — one exchange. Mike asked "Remember the rule of three?" BB admitted ignorance. Mike did not explain. Rule of three remains undefined.',
    key_moments: ['rule of three probed', 'BB admitted gap honestly'],
    mood: 'testing',
  });

  // Sessions 39+ on June 26: recoverable from extraction timestamp clusters
  profile.session_history.push({
    sessions: '39-~60',
    date: '2026-06-25',
    date_range: '2026-06-25 to 2026-06-26',
    summary: 'Multiple sessions across two days. June 26 included gym session (~4:27 PM), CASTECH/KazTech meeting confirmed as Thursday. Quit journey data, trigger mapping, and risk windows captured. Detailed session-level records not available.',
    gap: true,
  });

  // Mark the boundary
  profile.session_history.push({
    session: null,
    date: '2026-06-27',
    summary: '── Session history recording begins here. All sessions from this point forward are individually tracked. ──',
    boundary: true,
  });
}

/**
 * Prune a profile to stay under size limits.
 * Called before every write.
 * - daily_usage entries: keep last 3 days, aggregate older into daily summaries
 * - timestamped arrays: cap at 15 (drop oldest)
 * - activity_log: cap at 20 entries
 * - life_architecture arrays: cap at 15
 * Target: profile under 15K chars, system prompt under 35K.
 */
function pruneProfile(profile) {
  // Cap timestamped arrays at 15, keep most recent
  for (const field of TIMESTAMPED_ARRAYS) {
    if (profile[field] && profile[field].length > 15) {
      profile[field] = profile[field].slice(-15);
    }
  }

  // Cap activity_log at 20 entries (most recent)
  if (profile.activity_log && profile.activity_log.length > 20) {
    // Before dropping, aggregate older entries into daily summaries
    const kept = profile.activity_log.slice(-20);
    const dropped = profile.activity_log.slice(0, -20);

    // Build daily summaries from dropped entries
    const dailySummaries = {};
    for (const ev of dropped) {
      const d = ev.date || 'undated';
      if (!dailySummaries[d]) {
        dailySummaries[d] = { smokes: 0, resists: 0, total: 0 };
      }
      dailySummaries[d].total++;
      if (ev.type === 'smoke') dailySummaries[d].smokes++;
      if (ev.type === 'resist') dailySummaries[d].resists++;
    }

    // Store aggregated summaries
    if (!Array.isArray(profile.daily_summaries)) profile.daily_summaries = [];
    for (const [date, summary] of Object.entries(dailySummaries)) {
      const existing = profile.daily_summaries.find(s => s.date === date);
      if (existing) {
        existing.smokes += summary.smokes;
        existing.resists += summary.resists;
        existing.total += summary.total;
      } else {
        profile.daily_summaries.push({ date, ...summary });
      }
    }
    // Cap daily summaries at 30 days
    if (profile.daily_summaries.length > 30) {
      profile.daily_summaries = profile.daily_summaries.slice(-30);
    }

    profile.activity_log = kept;
  }

  // Cap risk_windows at 20
  if (profile.risk_windows && profile.risk_windows.length > 20) {
    profile.risk_windows.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    profile.risk_windows = profile.risk_windows.slice(0, 20);
  }

  // Cap session_outcomes at 50
  if (profile.session_outcomes && profile.session_outcomes.length > 50) {
    profile.session_outcomes = profile.session_outcomes.slice(-50);
  }

  // Cap life_architecture arrays at 15
  if (profile.life_architecture) {
    for (const field of LIFE_ARCH_ARRAYS) {
      if (Array.isArray(profile.life_architecture[field]) && profile.life_architecture[field].length > 15) {
        profile.life_architecture[field] = profile.life_architecture[field].slice(-15);
      }
    }
  }

  // Cap schedule_model arrays at 15
  if (profile.schedule_model) {
    for (const field of SCHEDULE_MODEL_ARRAYS) {
      if (Array.isArray(profile.schedule_model[field]) && profile.schedule_model[field].length > 15) {
        profile.schedule_model[field] = profile.schedule_model[field].slice(-15);
      }
    }
  }

  // Session history: keep gap/boundary entries + last 30 individual sessions.
  // Older individual sessions get compressed to one-liners.
  if (profile.session_history && profile.session_history.length > 40) {
    const special = profile.session_history.filter(e => e.gap || e.boundary);
    const individual = profile.session_history.filter(e => !e.gap && !e.boundary);
    const keep = individual.slice(-30);
    const compress = individual.slice(0, -30);
    if (compress.length > 0) {
      const firstDate = compress[0].date || '?';
      const lastDate = compress[compress.length - 1].date || '?';
      const sessionNums = compress.map(e => e.session).filter(Boolean);
      special.push({
        sessions: sessionNums.length > 0 ? `${sessionNums[0]}-${sessionNums[sessionNums.length - 1]}` : `${compress.length} sessions`,
        date_range: `${firstDate} to ${lastDate}`,
        summary: compress.map(e => `${e.date}: ${(e.summary || '').slice(0, 60)}`).join('; '),
        gap: true,
      });
    }
    profile.session_history = [...special, ...keep];
  }

  return profile;
}

// Read order: (1) in-memory cache, warmed from Supabase's user_profiles at
// boot by warmProfileStoreFromSupabase() — a cache hit here IS the "Supabase
// first" read. (2) the volume file, for a user who existed before this
// process's boot but isn't in Supabase yet (migration fallback). (3) a
// default empty profile for a genuinely new user.
export function loadProfile(rawUserId) {
  const userId = resolveUserId(rawUserId);
  if (profiles[userId]) return profiles[userId];

  let loaded = null;
  const path = getStorePath(userId);
  if (existsSync(path)) {
    try {
      loaded = migrateProfile(JSON.parse(readFileSync(path, 'utf-8')));
    } catch {}
  }

  // Canonical file missing or empty (e.g. an alias's history never got merged in) —
  // check known aliases on disk and adopt the first one with real session history.
  if (!loaded || !loaded.session_count) {
    for (const alias of getAliasesFor(userId)) {
      const aliasPath = getStorePath(alias);
      if (!existsSync(aliasPath)) continue;
      try {
        const aliasProfile = migrateProfile(JSON.parse(readFileSync(aliasPath, 'utf-8')));
        if (aliasProfile.session_count) {
          loaded = aliasProfile;
          break;
        }
      } catch {}
    }
  }

  if (loaded) {
    profiles[userId] = loaded;
    // Converge future reads onto Supabase so this volume fallback is a one-time cost.
    saveProfile(userId);
    return profiles[userId];
  }

  profiles[userId] = {
    name: null,
    age: null,
    location: null,
    occupation: null,
    family: null,
    addiction_type: null,
    substance_history: null,
    daily_usage: null,
    quit_reason: null,
    health_concerns: null,
    previous_quit_attempts: null,
    longest_quit: null,
    triggers: [],
    coping_strategies: [],
    what_works: [],
    what_doesnt_work: [],
    motivations: [],
    life_context: [],
    preferred_coping_style: null,
    response_preference: null,
    emotional_patterns: null,
    voice_preference: readDefaultVoicePreference(),
    session_count: 0,
    last_updated: null,
    last_session_at: null,
    recent_insights: [],
    next_session_hints: [],
    user_quotes: [],
    unknowns: [],
    risk_windows: [],
    activity_log: [],
    daily_summaries: [],
    session_history: [],
    life_architecture: {
      trigger_taxonomy: [],
      flow_state_activities: [],
      physical_risk_spaces: [],
      oral_habit_pairs: [],
      transition_patterns: [],
      urge_model: null,
      resistance_strategies: [],
      social_contexts: [],
    },
    schedule_model: {
      routine_blocks: [],
      vulnerability_windows: [],
      life_change_watch: [],
    },
  };
  return profiles[userId];
}

function saveProfile(userId) {
  const profile = profiles[userId];
  if (!profile) return;

  profile.last_updated = new Date().toISOString();

  // Prune before writing
  pruneProfile(profile);

  // Fire-and-forget — saveProfile is called synchronously from ~20 places
  // that never awaited the old writeFileSync either. Errors are logged, not
  // thrown, so a transient Supabase hiccup doesn't take down a request.
  upsertProfileRow(userId, profile).catch(err =>
    console.error(`[ContextAgent] Supabase profile save failed for ${userId}:`, err.message)
  );
}

/** Persist the (already-mutated) cached profile to Supabase with pruning applied. */
export function persistProfile(rawUserId) {
  saveProfile(resolveUserId(rawUserId));
}

/**
 * Full profile replacement: swaps both the Supabase row and the in-memory
 * cache. Unlike Object.assign onto the cached object, fields absent from the
 * new profile actually disappear.
 */
export function replaceProfile(rawUserId, newProfile) {
  const userId = resolveUserId(rawUserId);
  profiles[userId] = migrateProfile(newProfile);
  saveProfile(userId);
  return profiles[userId];
}

/**
 * Snapshot of every profile this process currently holds in memory — the
 * same object saveProfile writes through to Supabase, so it's always
 * current. Used by the admin console and the in-process design loop instead
 * of scanning the volume, which saveProfile no longer writes to.
 */
export function listKnownProfiles() {
  return Object.keys(profiles)
    .filter(userId => !(userId in USER_ALIASES))
    .map(userId => ({ userId, ...profiles[userId] }));
}

/**
 * Merge a batch of synced messages into a session's transcript file without
 * clobbering fuller copies written by the live session path. Dedupes by
 * message id, keeps chronological order.
 */
export function appendTranscriptMessages(rawUserId, sessionId, newMessages) {
  if (!newMessages || !newMessages.length) return;
  const userId = resolveUserId(rawUserId || 'default');
  const dir = resolve(TRANSCRIPT_DIR, userId);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  const safeSessionId = String(sessionId || 'unknown-session').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = resolve(dir, `${safeSessionId}.json`);

  let existing = { userId, sessionId: safeSessionId, messages: [] };
  try { existing = JSON.parse(readFileSync(filePath, 'utf-8')); } catch {}

  const seen = new Set((existing.messages || []).map(m => m.id).filter(Boolean));
  const merged = [...(existing.messages || [])];
  for (const m of newMessages) {
    if (m.id && seen.has(m.id)) continue;
    merged.push(m);
    if (m.id) seen.add(m.id);
  }
  merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  writeFileSync(filePath, JSON.stringify({
    ...existing,
    userId,
    sessionId: safeSessionId,
    updatedAt: new Date().toISOString(),
    messageCount: merged.length,
    messages: merged,
  }, null, 2));
}

/**
 * Parse a clock time string ("6:35 AM", "11:32 PM") into minutes since midnight.
 */
function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return 0;
  let hour = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return hour * 60 + min;
}

/**
 * Chronological comparator for activity_log entries. Times are stored as
 * 12-hour strings ("2:47 PM"), which string-compare WRONG ("2:47 PM" sorts
 * before "8:08 AM") — that bug silently pruned afternoon entries as "oldest"
 * and made computeUsageStats pick a morning smoke as the most recent one.
 */
function compareActivityEntries(a, b) {
  const dateCmp = (a.date || '').localeCompare(b.date || '');
  if (dateCmp !== 0) return dateCmp;
  return timeToMinutes(a.time) - timeToMinutes(b.time);
}

function relativeTime(isoString) {
  if (!isoString) return '';
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return 'earlier today';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return 'earlier today';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return 'last week';
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return 'last month';
  return `${months} months ago`;
}

/**
 * Rank coping strategies by observed efficacy — count of logged resists dated
 * on/after each strategy's captured_at (day granularity; captured_at is UTC
 * and activity_log dates are local, so this is a rough ranking signal, not a
 * precise causal link — bb_events doesn't yet tag which strategy a given
 * resist used).
 */
export function rankCopingStrategies(profile, limit = 5) {
  const strategies = profile.coping_strategies || [];
  if (strategies.length === 0) return null;

  const resists = (profile.activity_log || []).filter(ev => ev.type === 'resist');

  const ranked = strategies.map(item => {
    const val = itemValue(item);
    const capturedDate = item?.captured_at ? item.captured_at.slice(0, 10) : null;
    const efficacyCount = capturedDate ? resists.filter(r => (r.date || '') >= capturedDate).length : 0;
    return { val, capturedAt: item?.captured_at || '', efficacyCount };
  }).filter(i => i.val);

  ranked.sort((a, b) => b.efficacyCount - a.efficacyCount || b.capturedAt.localeCompare(a.capturedAt));

  const formatted = ranked.slice(0, limit).map(i =>
    i.efficacyCount > 0 ? `${i.val} (${i.efficacyCount} resists since)` : `${i.val} (not enough data yet)`
  );

  return `Coping strategies (ranked by observed effectiveness): ${formatted.join('; ')}.`;
}

/**
 * Does the user's current local time fall inside one of their documented
 * risk_windows? Returns the highest-weighted match, or null.
 */
export function findActiveRiskWindow(rawUserId, timezone = 'America/Chicago') {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);
  if (!p.risk_windows || p.risk_windows.length === 0) return null;

  let hour, dow;
  try {
    const now = new Date();
    hour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false,
    }).format(now), 10) % 24;
    const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now);
    dow = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(weekdayName);
  } catch {
    return null;
  }

  const matches = p.risk_windows.filter(rw =>
    rw.hour === hour && (rw.day_of_week === null || rw.day_of_week === undefined || rw.day_of_week === dow)
  );
  if (matches.length === 0) return null;

  matches.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return matches[0];
}

/**
 * Classify the user's current position on the resistance arc from recent
 * logged activity. Distinct from buildCurrentGoal's own contemplation /
 * autopilot / active-resistance phase (which drives conversational stance) —
 * this reuses batchProfiler.js's three-value taxonomy so the two systems
 * speak the same language once the batch layer is wired to live data.
 *
 * Thresholds (3+ consecutive smokes = "relapse", resists > smokes = "active
 * resistance", otherwise "tapering") are a starting judgment call, not a
 * clinical standard — tune freely as real usage data comes in.
 */
export function computeJourneyPhase(rawUserId) {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);
  const recent = (p.activity_log || []).filter(ev => ev.type === 'smoke' || ev.type === 'resist').slice(-14);

  if (recent.length === 0) {
    return { phase: 'tapering', reasoning: 'Not enough logged activity yet to classify.' };
  }

  let trailingSmokeRun = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].type === 'smoke') trailingSmokeRun++;
    else break;
  }
  const resists = recent.filter(e => e.type === 'resist').length;
  const smokes = recent.filter(e => e.type === 'smoke').length;

  if (trailingSmokeRun >= 3) {
    return {
      phase: 'relapse',
      reasoning: `${trailingSmokeRun} consecutive smokes logged with no resist between them.`,
    };
  }
  if (resists > smokes) {
    return {
      phase: 'active_resistance',
      reasoning: `${resists} resists vs ${smokes} smokes in the last ${recent.length} logged events.`,
    };
  }
  return {
    phase: 'tapering',
    reasoning: `${smokes} smokes vs ${resists} resists in the last ${recent.length} logged events.`,
  };
}

/**
 * Build a natural language summary from the structured profile.
 * This is what the real-time agent reads in {{profile}}.
 */
export function buildProfileSummary(rawUserId) {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);
  const parts = [];

  if (p.name) parts.push(`Name: ${p.name}.`);
  if (p.age) parts.push(`Age: ${p.age}.`);
  if (p.occupation) {
    const when = p.occupation_updated_at ? ` (as of ${relativeTime(p.occupation_updated_at)})` : '';
    parts.push(`Occupation: ${p.occupation}${when}.`);
  }
  if (p.family) {
    const when = p.family_updated_at ? ` (as of ${relativeTime(p.family_updated_at)})` : '';
    parts.push(`Family: ${p.family}${when}.`);
  }
  if (p.location) parts.push(`Location: ${p.location}.`);
  if (p.addiction_type) parts.push(`Battling: ${p.addiction_type}.`);
  if (p.substance_history) parts.push(`History: ${p.substance_history}.`);
  if (p.daily_usage) {
    const when = p.daily_usage_updated_at ? ` (as of ${relativeTime(p.daily_usage_updated_at)})` : '';
    parts.push(`Current usage: ${p.daily_usage}${when}.`);
  }
  if (p.quit_reason) parts.push(`Why quitting: ${p.quit_reason}.`);
  if (p.health_concerns) parts.push(`Health: ${p.health_concerns}.`);
  if (p.previous_quit_attempts) parts.push(`Past attempts: ${p.previous_quit_attempts}.`);
  if (p.longest_quit) parts.push(`Longest quit: ${p.longest_quit}.`);

  const formatArray = (label, arr, limit) => {
    if (!arr || arr.length === 0) return;
    const items = arr.slice(-limit);
    const formatted = items.map(item => {
      const val = itemValue(item);
      const ts = item?.captured_at;
      return ts ? `${val} [${relativeTime(ts)}]` : val;
    });
    parts.push(`${label}: ${formatted.join('; ')}.`);
  };

  formatArray('Known triggers', p.triggers, 5);
  formatArray('What works', p.what_works, 5);
  formatArray("What doesn't work", p.what_doesnt_work, 3);
  formatArray('Motivations', p.motivations, 5);
  formatArray('Life context', p.life_context, 5);

  const rankedCoping = rankCopingStrategies(p, 5);
  if (rankedCoping) parts.push(rankedCoping);

  if (p.preferred_coping_style) parts.push(`Preferred coping: ${p.preferred_coping_style}.`);
  if (p.response_preference) parts.push(`Prefers: ${p.response_preference}.`);
  if (p.emotional_patterns) parts.push(`Emotional pattern: ${p.emotional_patterns}.`);

  if (p.user_quotes && p.user_quotes.length > 0) {
    const last = p.user_quotes[p.user_quotes.length - 1];
    const val = itemValue(last);
    const when = last?.captured_at ? ` (${relativeTime(last.captured_at)})` : '';
    parts.push(`In their words${when}: "${val}"`);
  }

  parts.push(`${p.session_count} sessions.`);

  if (p.recent_insights && p.recent_insights.length > 0) {
    const last = p.recent_insights[p.recent_insights.length - 1];
    const val = itemValue(last);
    const when = last?.captured_at ? ` (${relativeTime(last.captured_at)})` : '';
    parts.push(`Recent insight${when}: ${val}`);
  }

  if (p.risk_windows && p.risk_windows.length > 0) {
    const windows = p.risk_windows
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 5)
      .map(rw => {
        const h = rw.hour > 12 ? `${rw.hour - 12}pm` : rw.hour === 0 ? '12am' : `${rw.hour}am`;
        const day = rw.day_of_week !== null && rw.day_of_week !== undefined
          ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][rw.day_of_week] + ' '
          : '';
        return `${day}${h} (${Math.round((rw.weight || 0.5) * 100)}% — ${rw.source || 'observed'})`;
      });
    parts.push(`VULNERABILITY WINDOWS (times this user is most at risk): ${windows.join('; ')}.`);
  }

  if (p.schedule_model?.routine_blocks?.length > 0) {
    const blocks = p.schedule_model.routine_blocks.map(b => `${b.label}${b.protects ? ' (protective)' : ' (risk)'}`);
    parts.push(`Daily routine: ${blocks.join('; ')}.`);
  }

  if (p.schedule_model?.life_change_watch?.length > 0) {
    const watch = p.schedule_model.life_change_watch.map(w => typeof w === 'string' ? w : (w.note || JSON.stringify(w)));
    parts.push(`Life changes to watch: ${watch.join('; ')}.`);
  }

  // The chronological activity timeline — BB can recite this back precisely
  if (p.activity_log && p.activity_log.length > 0) {
    const byDate = {};
    for (const ev of p.activity_log) {
      const d = ev.date || 'undated';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(ev);
    }
    const dates = Object.keys(byDate).sort().slice(-2); // last 2 days — older days live in daily_summaries
    const lines = dates.map(d => {
      const events = byDate[d]
        .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))
        .map(ev => {
          const verified = ev.verified ? '' : ' [unverified time]';
          return `${ev.time} — ${ev.event}${ev.type && ev.type !== 'other' ? ` [${ev.type}]` : ''}${verified}`;
        });
      const label = d === 'undated' ? '' : `${d}: `;
      return `${label}${events.join(' → ')}`;
    });
    parts.push(`ACTIVITY TIMELINE (only cite times the user explicitly reported — times marked [unverified] were system-estimated): ${lines.join(' || ')}`);
  }

  if (p.session_outcomes && p.session_outcomes.length > 0) {
    const recent = p.session_outcomes.slice(-10);
    const resisted = recent.filter(o => o.outcome === 'resisted').length;
    const gaveIn = recent.filter(o => o.outcome === 'gave_in').length;
    parts.push(`SESSION OUTCOMES (last ${recent.length}): ${resisted} resisted, ${gaveIn} gave in.`);
  }

  // Session history — the chronological record of our time together.
  // Rendered on a budget: the last few sessions in full, everything older as
  // one-liners. The prompt is rebuilt every turn, so rendered size is paid on
  // every single Haiku call — depth of recall must not cost first-token latency.
  if (p.session_history && p.session_history.length > 0) {
    const FULL_DETAIL_COUNT = 5;
    const individual = p.session_history.filter(e => !e.gap && !e.boundary);
    const fullDetailFrom = individual.length > FULL_DETAIL_COUNT
      ? individual[individual.length - FULL_DETAIL_COUNT]
      : individual[0];

    const historyLines = [];
    let reachedFullDetail = false;
    for (const entry of p.session_history) {
      if (entry === fullDetailFrom) reachedFullDetail = true;
      if (entry.gap) {
        const range = entry.sessions || entry.date_range || '?';
        historyLines.push(`[${range}] ${entry.summary}`);
      } else if (entry.boundary) {
        historyLines.push(entry.summary);
      } else if (reachedFullDetail || individual.length <= FULL_DETAIL_COUNT) {
        const num = entry.session ? `Session ${entry.session}` : entry.date;
        const time = entry.time ? ` ${entry.time}` : '';
        const mood = entry.mood ? ` [${entry.mood}]` : '';
        const moments = entry.key_moments?.length > 0 ? ` — ${entry.key_moments.join('; ')}` : '';
        historyLines.push(`${num} (${entry.date}${time})${mood}: ${entry.summary}${moments}`);
      } else {
        const num = entry.session ? `S${entry.session}` : '';
        historyLines.push(`${num} ${entry.date || ''}: ${(entry.summary || '').slice(0, 80)}`.trim());
      }
    }
    parts.push(`SESSION HISTORY (our chronological journey — reference specific sessions when relevant): ${historyLines.join(' || ')}`);
  }

  if (p.unknowns && p.unknowns.length > 0) {
    const vals = p.unknowns.map(u => itemValue(u));
    parts.push(`THINGS TO ASK ABOUT (the user mentioned these but never explained them — ask naturally when the moment is right): ${vals.join('; ')}`);
  }

  if (p.next_session_hints && p.next_session_hints.length > 0) {
    const vals = p.next_session_hints.slice(0, 3).map(h => itemValue(h));
    parts.push(`Follow up on: ${vals.join(' | ')}`);
  }

  if (parts.length <= 1) return 'New user — no history yet.';

  // Hard budget: the profile is injected into every turn's system prompt.
  // 12K chars ≈ 3K tokens — beyond that, trim the longest narrative sections
  // rather than shipping an ever-growing prompt (latency is the product).
  const MAX_PROFILE_CHARS = 12000;
  let summary = parts.join(' ');
  if (summary.length > MAX_PROFILE_CHARS) {
    const trimmable = ['SESSION HISTORY', 'ACTIVITY TIMELINE', 'Life context'];
    for (const label of trimmable) {
      if (summary.length <= MAX_PROFILE_CHARS) break;
      const idx = parts.findIndex(s => s.startsWith(label));
      if (idx !== -1) {
        const excess = summary.length - MAX_PROFILE_CHARS;
        const target = Math.max(400, parts[idx].length - excess);
        if (parts[idx].length > target) {
          parts[idx] = parts[idx].slice(0, target) + ' …[trimmed for length]';
        }
        summary = parts.join(' ');
      }
    }
    if (summary.length > MAX_PROFILE_CHARS) {
      summary = summary.slice(0, MAX_PROFILE_CHARS) + ' …[trimmed for length]';
    }
  }
  return summary;
}

/**
 * Build a natural language summary of the user's life architecture.
 * This goes in the {{life_architecture}} placeholder.
 */
export function buildLifeArchitectureSummary(rawUserId) {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);
  const la = p.life_architecture;
  if (!la) return 'Not yet discovered — learn through conversation.';

  const parts = [];

  if (la.trigger_taxonomy && la.trigger_taxonomy.length > 0) {
    const triggers = la.trigger_taxonomy.map(t => {
      let s = t.trigger || t.value || '';
      if (t.context) s += ` (${t.context})`;
      if (t.intensity) s += ` — intensity ${t.intensity}/10`;
      return s;
    });
    parts.push(`TRIGGER MAP (discovered for this user): ${triggers.join('; ')}`);
  }

  if (la.flow_state_activities && la.flow_state_activities.length > 0) {
    const vals = la.flow_state_activities.map(i => typeof i === 'string' ? i : (i.value || i.activity || ''));
    parts.push(`FLOW STATES (activities that eliminate urges for this user): ${vals.join(', ')}`);
  }

  if (la.physical_risk_spaces && la.physical_risk_spaces.length > 0) {
    const vals = la.physical_risk_spaces.map(i => typeof i === 'string' ? i : (i.value || i.space || ''));
    parts.push(`RISK SPACES (locations associated with smoking): ${vals.join(', ')}`);
  }

  if (la.oral_habit_pairs && la.oral_habit_pairs.length > 0) {
    const vals = la.oral_habit_pairs.map(i => typeof i === 'string' ? i : (i.value || ''));
    parts.push(`ORAL HABIT PAIRS: ${vals.join(', ')}`);
  }

  if (la.urge_model) {
    parts.push(`HOW URGES FEEL (in their words): "${la.urge_model}"`);
  }

  if (la.resistance_strategies && la.resistance_strategies.length > 0) {
    const vals = la.resistance_strategies.map(i => typeof i === 'string' ? i : (i.value || i.strategy || ''));
    parts.push(`WHAT WORKS FOR THIS USER: ${vals.join('; ')}`);
  }

  if (la.social_contexts && la.social_contexts.length > 0) {
    const vals = la.social_contexts.map(i => typeof i === 'string' ? i : (i.value || ''));
    parts.push(`SOCIAL CONTEXTS affecting usage: ${vals.join('; ')}`);
  }

  if (la.transition_patterns && la.transition_patterns.length > 0) {
    const vals = la.transition_patterns.map(i => typeof i === 'string' ? i : (i.value || ''));
    parts.push(`TRANSITION PATTERNS: ${vals.join('; ')}`);
  }

  if (parts.length === 0) return 'Not yet discovered — learn through conversation.';

  // Same per-turn size budget rationale as buildProfileSummary.
  const MAX_LIFE_ARCH_CHARS = 6000;
  let out = parts.join('\n');
  if (out.length > MAX_LIFE_ARCH_CHARS) {
    out = out.slice(0, MAX_LIFE_ARCH_CHARS) + ' …[trimmed for length]';
  }
  return out;
}

/**
 * Build the agent's current operating goal — injected as {{current_goal}}.
 *
 * Not a checklist. A living stance: what phase is this person in, what's still
 * dark on the map, and what insights are queued to surface when the moment is right.
 * Deterministic — no LLM call, always on the fast path.
 */
/**
 * An insight is "ready" when there's enough pattern data to name something
 * the user hasn't named themselves. Shared by buildCurrentGoal (surfaced as
 * background guidance) and computeEligibleStarters (surfaced as an explicit
 * "pattern_spotlight" conversation-starter offer).
 */
function computeInsightReady(p) {
  const insightReady = [];
  const triggers = p.triggers || [];
  const triggerStr = t => (typeof t === 'string' ? t : (t.value || t.trigger || '')).toLowerCase();
  const transitionTriggers = triggers.filter(t =>
    triggerStr(t).includes('transit') || triggerStr(t).includes('exit')
  );
  if (transitionTriggers.length >= 2) {
    insightReady.push('transition-exit trigger cluster — they keep naming the same pattern in different words; it\'s ready to be reflected back');
  }

  const la2 = p.life_architecture || {};
  if ((la2.trigger_taxonomy || []).length >= 3 && (la2.flow_state_activities || []).length >= 1) {
    insightReady.push('flow-state as natural circuit breaker — their absorption activities already create smoke-free windows; name this as progress, not accident');
  }

  const resistCount = (p.activity_log || []).filter(ev => ev.type === 'resist').length;
  if (resistCount >= 3) {
    insightReady.push(`${resistCount} logged resists — they may not be counting these; surfacing this number can shift self-perception`);
  }

  const sessionCount = p.session_count || 0;
  if (sessionCount >= 5 && triggers.length >= 5) {
    insightReady.push('trigger map is rich enough to name a pattern they haven\'t seen: most of their triggers are about transitions and unstructured time, not nicotine itself');
  }

  return insightReady;
}

/**
 * Deterministic, no-LLM-call eligibility check for the conversation-starter
 * library (server/prompts/conversation-starters.md). Each category fires
 * only once real data backs it — this must never invite BB to offer a
 * recap/pattern/etc. it can't actually deliver on.
 *
 * Deliberately stateless for v1 (no cross-session cooldown/repetition
 * tracking) — the system prompt instructs BB to pick at most one eligible
 * category per session and not repeat one just declined. Add cooldown
 * bookkeeping later only if repetition turns out to be a real problem.
 */
export function computeEligibleStarters(rawUserId) {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);
  const eligible = [];

  if ((p.session_count || 0) >= 5) {
    eligible.push({ id: 'full_recap', label: 'Enough history exists for a full journey recap.' });
  }

  if (computeInsightReady(p).length > 0) {
    eligible.push({ id: 'pattern_spotlight', label: 'A pattern is confident enough to reflect back.' });
  }

  const rankedCoping = (p.coping_strategies || []).length > 0 ? rankCopingStrategies(p, 5) : null;
  if (rankedCoping && /\(\d+ resists since\)/.test(rankedCoping)) {
    eligible.push({ id: 'whats_working', label: 'At least one coping strategy has observed resists behind it.' });
  }

  const sm = p.schedule_model || {};
  if ((sm.vulnerability_windows || []).length >= 1 || (p.risk_windows || []).length >= 2) {
    eligible.push({ id: 'your_hours', label: 'Risk windows are mapped with enough signal to walk through.' });
  }

  if ((sm.routine_blocks || []).length >= 1) {
    eligible.push({ id: 'daily_rhythm', label: 'At least one routine block has been discovered.' });
  }

  if ((p.session_outcomes || []).length >= 5) {
    eligible.push({ id: 'progress_check', label: 'Enough session outcomes exist to show the arc, not just today.' });
  }

  if ((p.unknowns || []).length > 0) {
    eligible.push({ id: 'open_thread', label: 'At least one open thread was never followed up on.' });
  }

  return eligible;
}

export function buildCurrentGoal(rawUserId) {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);

  // ── Determine current phase ──────────────────────────────────────────────
  // Inferred from recent activity and engagement patterns.
  const recentActivity = (p.activity_log || []).slice(-10);
  const recentResists = recentActivity.filter(ev => ev.type === 'resist').length;
  const recentSmokes = recentActivity.filter(ev => ev.type === 'smoke').length;
  const daysSinceSession = p.last_session_at
    ? Math.floor((Date.now() - new Date(p.last_session_at).getTime()) / 86400000)
    : null;

  let phase;
  if (recentResists > recentSmokes && recentResists > 0) {
    phase = 'active-resistance';
  } else if (daysSinceSession !== null && daysSinceSession > 3) {
    phase = 'autopilot';
  } else if (p.session_count && p.session_count < 3) {
    phase = 'contemplation';
  } else {
    phase = 'autopilot';
  }

  // ── Identify what's still dark on the map ───────────────────────────────
  const la = p.life_architecture || {};
  const dark = [];
  if (!la.trigger_taxonomy || la.trigger_taxonomy.length === 0)
    dark.push('trigger map (none yet — listen for transition moments, exits, blank-space gaps)');
  if (!la.flow_state_activities || la.flow_state_activities.length < 2)
    dark.push('flow states (activities that absorb them fully — the natural cigarette replacements)');
  if (!la.resistance_strategies || la.resistance_strategies.length === 0)
    dark.push('what has worked in past attempts — what strategies have they tried before?');
  if (!p.longest_quit || p.longest_quit === 'unknown')
    dark.push('longest quit — how long have they managed before? what ended it?');
  if (!la.social_contexts || la.social_contexts.length === 0)
    dark.push('social contexts around use — who are they usually with? what social rituals are tied to it?');

  // ── Identify insights ready to surface ──────────────────────────────────
  const insightReady = computeInsightReady(p);

  // ── Assemble the goal block ──────────────────────────────────────────────
  const phaseLabel = {
    'contemplation': 'CONTEMPLATION — aware of the pattern, not yet actively resisting. Be curious, not directive.',
    'autopilot': 'AUTOPILOT — their habit is running. This is the primary data-collection phase. Observe without judgment.',
    'active-resistance': 'ACTIVE RESISTANCE — they are choosing differently right now. Be present. Celebrate without making it precious.',
  }[phase] || 'AUTOPILOT';

  const journey = computeJourneyPhase(userId);
  const journeyGuidance = {
    active_resistance: 'They are actively choosing differently right now. Be present, celebrate without making it precious.',
    tapering: 'Reducing but not yet mostly resisting — real progress. Reflect the trend, not a verdict.',
    relapse: 'A sustained non-resisting stretch. No judgment, no urgency to fix it — stay present and keep gathering what their life looks like right now.',
  }[journey.phase];

  const lines = [
    'GOAL: Build a living map of this person — not to push them toward quitting, but so you can reflect their own pattern back to them accurately, compassionately, and at the right moment.',
    '',
    `CURRENT PHASE: ${phaseLabel}`,
    '',
    `JOURNEY PHASE (internal tone guide — never say this label or the word "phase" to the user): ${journey.phase} — ${journey.reasoning} ${journeyGuidance}`,
    '',
  ];

  if (dark.length > 0) {
    lines.push('STILL DARK ON THE MAP (what to listen for, never interrogate):');
    dark.forEach(d => lines.push(`  • ${d}`));
    lines.push('');
  }

  if (insightReady.length > 0) {
    lines.push('INSIGHTS QUEUED TO SURFACE (when the moment fits naturally):');
    insightReady.forEach(i => lines.push(`  • ${i}`));
    lines.push('');
  }

  const eligibleStarters = computeEligibleStarters(userId);
  if (eligibleStarters.length > 0) {
    lines.push('ELIGIBLE CONVERSATION STARTERS (see server/prompts/conversation-starters.md for phrasing and what each one executes — offer AT MOST ONE, only if it actually fits this moment, never as a listed menu, never one just declined this session):');
    eligibleStarters.forEach(s => lines.push(`  • ${s.id} — ${s.label}`));
    lines.push('');
  }

  lines.push('GOVERNING PRINCIPLE: There is no timeline. There is no quit date unless they bring one. There is only this person, this conversation, and the slowly accumulating weight of their own self-knowledge tilting the scales.');

  return lines.join('\n');
}

/**
 * Compute deterministic usage stats from the activity_log.
 * Returns { today_count, last_cigarette_at, gaps, average_gap_minutes, current_gap_minutes }
 */
export function computeUsageStats(rawUserId, timezone = 'America/Chicago') {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);

  let localDate;
  try {
    localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    localDate = new Date().toISOString().slice(0, 10);
  }

  const smokeEvents = (p.activity_log || []).filter(ev => ev.type === 'smoke');
  const todaySmokes = smokeEvents.filter(ev => ev.date === localDate);

  // Sort all smokes chronologically (numeric time compare — see compareActivityEntries)
  const allSmokes = [...smokeEvents].sort(compareActivityEntries);

  const lastSmoke = allSmokes.length > 0 ? allSmokes[allSmokes.length - 1] : null;

  // Compute gaps between consecutive smokes (in minutes)
  const gaps = [];
  for (let i = 1; i < allSmokes.length; i++) {
    const prevMin = timeToMinutes(allSmokes[i - 1].time);
    const currMin = timeToMinutes(allSmokes[i].time);
    if (allSmokes[i].date === allSmokes[i - 1].date) {
      gaps.push(currMin - prevMin);
    }
  }

  const avgGap = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  // Current gap from last cigarette to now
  let currentGapMinutes = null;
  if (lastSmoke) {
    try {
      let localNowStr;
      try {
        localNowStr = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date());
      } catch {
        localNowStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      }
      const nowMin = timeToMinutes(localNowStr);
      const lastMin = timeToMinutes(lastSmoke.time);
      if (lastSmoke.date === localDate) {
        currentGapMinutes = nowMin - lastMin;
      }
    } catch {}
  }

  return {
    today_count: todaySmokes.length,
    last_cigarette_at: lastSmoke ? `${lastSmoke.time} on ${lastSmoke.date}` : null,
    gaps,
    average_gap_minutes: avgGap,
    current_gap_minutes: currentGapMinutes,
  };
}

/**
 * Look up a single profile field value.
 */
export function lookupProfileField(rawUserId, field) {
  const userId = resolveUserId(rawUserId);
  const p = loadProfile(userId);

  // Check top-level fields
  if (field in p) {
    const val = p[field];
    if (Array.isArray(val)) {
      return val.map(item => itemValue(item)).filter(Boolean);
    }
    return val;
  }

  // Check life_architecture fields
  if (p.life_architecture && field in p.life_architecture) {
    const val = p.life_architecture[field];
    if (Array.isArray(val)) {
      return val.map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.value || item.trigger || item.activity || item.space || JSON.stringify(item);
        return '';
      }).filter(Boolean);
    }
    return val;
  }

  return null;
}

/** Map a schedule_model day_pattern to the risk_windows day_of_week values it covers. */
function dayPatternToDaysOfWeek(pattern) {
  const p = (pattern || '').toLowerCase();
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const idx = names.indexOf(p);
  if (idx !== -1) return [idx];
  if (p === 'weekdays') return [1, 2, 3, 4, 5];
  if (p === 'weekends') return [0, 6];
  return [null]; // daily / unspecified — applies every day
}

/**
 * Keep risk_windows in sync with schedule_model.vulnerability_windows, per
 * the product requirement that the two never drift apart. vulnerability_windows
 * carries the richer provenance (day_pattern, confidence, source_session);
 * risk_windows is the flat hour/day_of_week shape the rest of the system
 * (findActiveRiskWindow, buildProfileSummary) already reads.
 */
function syncVulnerabilityWindowsToRiskWindows(profile, sessionTimestamp) {
  const vws = profile.schedule_model?.vulnerability_windows || [];
  if (vws.length === 0) return;
  if (!Array.isArray(profile.risk_windows)) profile.risk_windows = [];

  for (const vw of vws) {
    const m = (vw.time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const hour = parseInt(m[1], 10);
    const weight = vw.confidence === 'confirmed' ? 0.8 : 0.5;

    for (const dow of dayPatternToDaysOfWeek(vw.day_pattern)) {
      const existing = profile.risk_windows.find(rw => rw.hour === hour && rw.day_of_week === dow);
      if (existing) {
        existing.weight = Math.max(existing.weight || 0, weight);
        if (vw.reason) existing.source = vw.reason;
        existing.updated_at = sessionTimestamp;
      } else {
        profile.risk_windows.push({
          hour, day_of_week: dow, weight, source: vw.reason || '',
          captured_at: sessionTimestamp, updated_at: sessionTimestamp,
        });
      }
    }
  }
}

/**
 * Analyze a batch of messages and update the user's profile.
 * Called asynchronously — never blocks the real-time conversation.
 */
export async function analyzeAndUpdate(rawUserId, messages, isSessionEnd = false, timezone = 'America/Chicago') {
  if (!messages || messages.length < 2) return;

  const userId = resolveUserId(rawUserId);
  const profile = loadProfile(userId);
  const sessionTimestamp = new Date().toISOString();

  // Track last_session_at
  if (!profile.last_session_at) {
    profile.last_session_at = sessionTimestamp;
  }

  // Persist the user's timezone so schedulers (nudges, audits) can evaluate
  // their local clock instead of assuming the default.
  if (timezone) profile.timezone = timezone;

  // The user's local time right now — used to resolve "I just had a cigarette" to an actual clock time
  let localNow, localDate;
  try {
    localNow = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
    localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    localNow = new Date().toLocaleString();
    localDate = new Date().toISOString().slice(0, 10);
  }

  // Build a simplified view of the profile for the extraction prompt
  const simplifiedProfile = {};
  for (const [key, value] of Object.entries(profile)) {
    if (Array.isArray(value) && TIMESTAMPED_ARRAYS.includes(key)) {
      simplifiedProfile[key] = value.map(item => itemValue(item));
    } else {
      simplifiedProfile[key] = value;
    }
  }
  const currentProfileJson = JSON.stringify(simplifiedProfile, null, 2);

  const recentMessages = messages.slice(-20);
  const transcript = recentMessages
    .map(m => `${m.role === 'user' ? 'User' : 'BB'}: ${m.content}`)
    .join('\n');

  const prompt = `You are a background analyst building a detailed dossier on a user of BattleBuddy, a quit-smoking AI companion.

Your job: extract EVERY concrete fact, detail, number, quote, and insight from this conversation. You are building a living document that another AI will read to have a real conversation with this person. If the extraction is vague, the next conversation will feel generic. If it's specific and quotes their actual words, the next conversation will feel like talking to someone who truly knows them.

CURRENT PROFILE:
${currentProfileJson}

NEW CONVERSATION:
${transcript}

THE USER'S CURRENT LOCAL TIME IS: ${localNow} (date: ${localDate}).
Use this to timestamp activities. When the user says "I just had a cigarette" or "I'm at the gym now," the event time is the current local time above. If they say "I had one an hour ago," subtract accordingly. If they give an explicit time ("6:35 this morning"), use that exact time.

${isSessionEnd ? `This is the end of a session. Generate next_session_hints — specific things to follow up on.

SESSION HISTORY — CRITICAL:
Also generate a "session_summary" object that captures this session for the chronological record. The user has explicitly asked for BB to track the chronological order of their time together. Format:
{
  "session_summary": {
    "date": "${localDate}",
    "time": "<approximate start time of this conversation, e.g. '7:30 AM'>",
    "summary": "<2-3 sentence summary of what happened this session — topics covered, key moments, outcomes>",
    "key_moments": ["<specific memorable events or exchanges from this session>"],
    "mood": "<user's overall mood/tone this session, e.g. 'frustrated', 'open', 'testing', 'engaged'>"
  }
}
Include the session_summary in your JSON output alongside other fields.` : 'This is a mid-session update.'}

CRITICAL — CORRECTIONS OVERWRITE OLD DATA:
If the user corrects something previously in the profile, return the CORRECTED value for that field. Do NOT append "user corrected this" — just return the right answer. The merge logic will overwrite the old value.

CRITICAL — TIMESTAMP VERIFICATION:
For activity_log entries, set "verified": true ONLY if the user explicitly stated the time. If you are estimating the time from "just now" or "a while ago" or the current clock, set "verified": false. This distinction is critical — the agent must never present unverified times as fact.

EXTRACTION RULES — be LITERAL and SPECIFIC:
- QUOTE the user's exact words when they describe feelings, metaphors, or experiences. Don't paraphrase.
- Use EXACT numbers. Don't round or approximate.
- Capture SPECIFIC names, products, books, medications, people.
- For health: quote their exact symptoms.
- For family: capture relationships with detail.
- For motivations: capture the WHY in their words.
- For life_context: capture anything personal — job, hobbies, daily routine, stress sources, relationships.
- For recent_insights: capture the user's own realizations in THEIR language.
- For next_session_hints: be specific — "ask about X" not "explore themes."

LIFE ARCHITECTURE EXTRACTION — build the user's unique map:
Extract into the life_architecture object:
- trigger_taxonomy: any time the user describes a trigger situation → { "trigger": "what", "context": "when/where", "intensity": 1-10, "verified": true }
- flow_state_activities: any activity the user says eliminates or suppresses urges → add it
- physical_risk_spaces: any location/space the user associates with smoking → add it
- oral_habit_pairs: activities paired with the oral/smoking habit (coffee + cigarette, beer + cigarette) → add them
- urge_model: if the user describes how urges FEEL in their own words/metaphors → capture their exact language
- resistance_strategies: strategies the user has tried that WORKED → add them
- social_contexts: social situations that affect usage (drinking with friends, work breaks, etc.) → add them
- transition_patterns: how the user moves between activities, especially transitions that trigger smoking → add them

UNKNOWNS AND ANSWERS:
- If the user mentions something BB doesn't know about and the user doesn't explain → add it to "unknowns" array
- If the user ANSWERS a previous unknown → add the explanation to the appropriate field AND add to "resolved_unknowns"
- If BB asks the user something and the user answers → capture that answer as a new fact

TIME-OF-DAY PATTERNS — RISK WINDOWS:
- If the user mentions a specific time of day in relation to cravings, smoking, triggers, or vulnerability, extract it as a risk_window object.
- Format: { "hour": 14, "day_of_week": null, "weight": 0.8, "source": "mentioned afternoon cravings after lunch" }
- hour: 0-23 (24h format). day_of_week: 0=Sunday through 6=Saturday, or null if not day-specific.
- weight: 0.0-1.0 (how strong the signal is)

SCHEDULE MODEL — the user's structure, from conversation, not questionnaires:
Extract into a "schedule_model" object when the user describes their routine, structure, or vulnerability. Only extract what's actually said — don't infer a routine block or vulnerability window from a single passing mention.
- routine_blocks: daily/weekly routines that PROTECT from risk or increase it → { "label": "work 9-12", "protects": true, "confidence": "confirmed" }. Set "protects": false for a routine that increases risk instead.
- vulnerability_windows: times of day/week that are hard, with WHY → { "time": "17:00", "day_pattern": "weekdays", "reason": "patch comes off, resistance drops", "confidence": "confirmed" }. time is 24h "HH:MM". day_pattern is one of: daily, weekdays, weekends, or a specific day name (e.g. "monday"). Always include a reason — a window without a reason isn't useful.
- life_change_watch: new stressors, job changes, travel, or life events that could shift risk → { "note": "started new job", "confidence": "confirmed" }
- confidence is "confirmed" (the user stated it plainly) or "tentative" (inferred from context, said once, or hedged).

ACTIVITY LOG — THE CHRONOLOGICAL TIMELINE (CRITICAL):
Every concrete activity, event, cigarette, resist, meal, gym session, work block, or mood the user reports must be captured as an activity_log entry.
- Format: { "time": "6:35 AM", "date": "${localDate}", "event": "had first cigarette of the day", "type": "smoke", "verified": true }
- type is one of: smoke, resist, craving, decision, gym, work, meal, sleep, mood, social, other
- Use "decision" when the user describes a CONSCIOUS CHOICE to smoke — not a slip, not giving in to an urge. Never use "smoke" for a decision; the distinction matters to the user.
- "verified": true if the user explicitly stated the time, false if estimated from context
- Use the user's EXACT words for the event when possible.
- ALWAYS include the time. If the user didn't state a time, use the current local time provided above BUT set verified to false.

Return a JSON object with ONLY fields that have NEW information. For arrays, return only NEW items to add (as plain strings — the system will add timestamps automatically). EXCEPTION: activity_log, risk_windows, and life_architecture items are objects, return them as objects per their format above.

Available fields:
name, age, location, occupation, family, addiction_type, substance_history, daily_usage,
quit_reason, health_concerns, previous_quit_attempts, longest_quit,
triggers (array), coping_strategies (array), what_works (array), what_doesnt_work (array),
motivations (array), life_context (array), preferred_coping_style, response_preference,
emotional_patterns, next_session_hints (array), recent_insights (array),
user_quotes (array), unknowns (array), resolved_unknowns (array),
risk_windows (array of objects),
activity_log (array of objects with verified flag),
life_architecture (object with: trigger_taxonomy, flow_state_activities, physical_risk_spaces, oral_habit_pairs, urge_model, resistance_strategies, social_contexts, transition_patterns),
schedule_model (object with: routine_blocks, vulnerability_windows, life_change_watch — see SCHEDULE MODEL section above),
session_summary (object — ONLY at session end: { date, time, summary, key_moments, mood })

Return ONLY valid JSON. No markdown, no explanation.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '{}';
    console.log(`[ContextAgent] Raw response (${text.length} chars):`, text.substring(0, 300));

    const updates = safeJsonParse(text);

    if (Object.keys(updates).length === 0) {
      console.log('[ContextAgent] No valid updates extracted, skipping');
      return null;
    }

    // Merge updates into profile
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) continue;
      if (key === 'resolved_unknowns') continue;
      if (key === 'risk_windows' || key === 'activity_log' || key === 'life_architecture' || key === 'schedule_model' || key === 'session_summary') continue; // handled separately below

      if (TIMESTAMPED_ARRAYS.includes(key) && Array.isArray(value)) {
        if (!Array.isArray(profile[key])) profile[key] = [];
        for (const item of value) {
          const val = typeof item === 'string' ? item : (item?.value || '');
          if (!val) continue;
          const isDuplicate = profile[key].some(existing => itemValue(existing) === val);
          if (!isDuplicate) {
            profile[key].push({ value: val, captured_at: sessionTimestamp });
          }
        }
      } else if (TIMESTAMPED_ARRAYS.includes(key) && typeof value === 'string') {
        if (!Array.isArray(profile[key])) profile[key] = [];
        const isDuplicate = profile[key].some(existing => itemValue(existing) === value);
        if (!isDuplicate) {
          profile[key].push({ value, captured_at: sessionTimestamp });
        }
      } else {
        profile[key] = value;
        if (DATED_SCALARS.includes(key)) {
          profile[`${key}_updated_at`] = sessionTimestamp;
        }
      }
    }

    // Handle risk_windows — merge by hour+day_of_week, update weight
    if (updates.risk_windows && Array.isArray(updates.risk_windows)) {
      if (!Array.isArray(profile.risk_windows)) profile.risk_windows = [];
      for (const rw of updates.risk_windows) {
        if (!rw || typeof rw.hour !== 'number') continue;
        const existing = profile.risk_windows.find(
          e => e.hour === rw.hour && e.day_of_week === (rw.day_of_week ?? null)
        );
        if (existing) {
          existing.weight = Math.max(existing.weight || 0, rw.weight || 0.5);
          if (rw.source) existing.source = rw.source;
          existing.updated_at = sessionTimestamp;
        } else {
          profile.risk_windows.push({
            hour: rw.hour,
            day_of_week: rw.day_of_week ?? null,
            weight: rw.weight || 0.5,
            source: rw.source || '',
            captured_at: sessionTimestamp,
            updated_at: sessionTimestamp,
          });
        }
      }
    }

    // Handle activity_log — append chronological events, dedupe by time+event
    if (updates.activity_log && Array.isArray(updates.activity_log)) {
      if (!Array.isArray(profile.activity_log)) profile.activity_log = [];
      for (const ev of updates.activity_log) {
        if (!ev || !ev.event) continue;
        const evDate = ev.date || localDate;
        const evTime = ev.time || localNow;
        const isDup = profile.activity_log.some(
          e => e.date === evDate && e.time === evTime && e.event === ev.event
        );
        if (!isDup) {
          profile.activity_log.push({
            time: evTime,
            date: evDate,
            event: ev.event,
            type: ev.type || 'other',
            verified: ev.verified !== undefined ? ev.verified : false,
            logged_at: sessionTimestamp,
          });
        }
      }
      profile.activity_log.sort(compareActivityEntries);
    }

    // Handle life_architecture — merge discovered fields
    if (updates.life_architecture && typeof updates.life_architecture === 'object') {
      if (!profile.life_architecture) {
        profile.life_architecture = {
          trigger_taxonomy: [], flow_state_activities: [], physical_risk_spaces: [],
          oral_habit_pairs: [], transition_patterns: [], urge_model: null,
          resistance_strategies: [], social_contexts: [],
        };
      }
      const la = updates.life_architecture;

      // urge_model is a scalar — overwrite if provided
      if (la.urge_model) {
        profile.life_architecture.urge_model = la.urge_model;
      }

      // Merge array fields
      for (const field of LIFE_ARCH_ARRAYS) {
        if (!la[field] || !Array.isArray(la[field])) continue;
        if (!Array.isArray(profile.life_architecture[field])) {
          profile.life_architecture[field] = [];
        }
        for (const item of la[field]) {
          if (!item) continue;
          // Dedup by checking string representation
          const itemStr = typeof item === 'string' ? item : JSON.stringify(item);
          const isDup = profile.life_architecture[field].some(existing => {
            const existStr = typeof existing === 'string' ? existing : JSON.stringify(existing);
            return existStr === itemStr;
          });
          if (!isDup) {
            profile.life_architecture[field].push(item);
          }
        }
      }
    }

    // Handle schedule_model — merge discovered routine/vulnerability/life-change
    // entries, then keep risk_windows in sync with vulnerability_windows.
    if (updates.schedule_model && typeof updates.schedule_model === 'object') {
      if (!profile.schedule_model) {
        profile.schedule_model = { routine_blocks: [], vulnerability_windows: [], life_change_watch: [] };
      }
      const sm = updates.schedule_model;
      // source_session is assigned here, not trusted from the LLM, to avoid a hallucinated id.
      const sourceSession = `session-${profile.session_count || 0}`;

      if (Array.isArray(sm.routine_blocks)) {
        for (const rb of sm.routine_blocks) {
          if (!rb?.label) continue;
          const exists = profile.schedule_model.routine_blocks.some(e => e.label === rb.label);
          if (!exists) {
            profile.schedule_model.routine_blocks.push({
              label: rb.label,
              protects: !!rb.protects,
              source_session: sourceSession,
              confidence: rb.confidence || 'tentative',
            });
          }
        }
      }

      if (Array.isArray(sm.vulnerability_windows)) {
        for (const vw of sm.vulnerability_windows) {
          if (!vw?.time) continue;
          const dayPattern = vw.day_pattern || 'daily';
          const exists = profile.schedule_model.vulnerability_windows.some(
            e => e.time === vw.time && e.day_pattern === dayPattern
          );
          if (!exists) {
            profile.schedule_model.vulnerability_windows.push({
              time: vw.time,
              day_pattern: dayPattern,
              reason: vw.reason || '',
              source_session: sourceSession,
              confidence: vw.confidence || 'tentative',
            });
          }
        }
      }

      if (Array.isArray(sm.life_change_watch)) {
        for (const note of sm.life_change_watch) {
          const noteText = typeof note === 'string' ? note : note?.note;
          if (!noteText) continue;
          const exists = profile.schedule_model.life_change_watch.some(e => (e.note || e) === noteText);
          if (!exists) {
            profile.schedule_model.life_change_watch.push({
              note: noteText,
              source_session: sourceSession,
              confidence: (typeof note === 'object' && note.confidence) || 'tentative',
            });
          }
        }
      }

      syncVulnerabilityWindowsToRiskWindows(profile, sessionTimestamp);
    }

    // Handle resolved unknowns
    if (updates.resolved_unknowns && Array.isArray(updates.resolved_unknowns)) {
      if (!Array.isArray(profile.unknowns)) profile.unknowns = [];
      for (const resolved of updates.resolved_unknowns) {
        profile.unknowns = profile.unknowns.filter(u =>
          !itemValue(u).toLowerCase().includes(resolved.toLowerCase())
        );
      }
    }

    if (isSessionEnd) {
      profile.session_count = (profile.session_count || 0) + 1;
      profile.last_session_at = sessionTimestamp;

      // Record session history entry
      if (updates.session_summary && typeof updates.session_summary === 'object') {
        if (!Array.isArray(profile.session_history)) profile.session_history = [];
        profile.session_history.push({
          session: profile.session_count,
          date: updates.session_summary.date || localDate,
          time: updates.session_summary.time || null,
          summary: updates.session_summary.summary || '',
          key_moments: updates.session_summary.key_moments || [],
          mood: updates.session_summary.mood || null,
          recorded_at: sessionTimestamp,
        });
      } else {
        // Fallback: record a minimal entry even if LLM didn't return one
        if (!Array.isArray(profile.session_history)) profile.session_history = [];
        profile.session_history.push({
          session: profile.session_count,
          date: localDate,
          summary: 'Session ended. No detailed summary extracted.',
          recorded_at: sessionTimestamp,
        });
      }
    }

    saveProfile(userId);
    console.log(`[ContextAgent] Updated profile for ${userId}: ${Object.keys(updates).join(', ')}`);

    return updates;
  } catch (err) {
    console.error(`[ContextAgent] Analysis failed:`, err.message);
    return null;
  }
}

/**
 * Seed a new user profile with their registration name.
 */
export function seedProfile(rawUserId, name) {
  const userId = resolveUserId(rawUserId);
  const profile = loadProfile(userId);
  if (!profile.name && name) {
    profile.name = name;
    saveProfile(userId);
  }
}

/**
 * Merge two profiles into the target. Used to combine dev + TestFlight identities.
 */
export function mergeProfiles(sourceId, targetId) {
  const source = loadProfile(sourceId);
  const target = loadProfile(targetId);

  target.session_count = (source.session_count || 0) + (target.session_count || 0);

  for (const field of TIMESTAMPED_ARRAYS) {
    if (!Array.isArray(target[field])) target[field] = [];
    for (const item of (source[field] || [])) {
      const val = itemValue(item);
      if (!val) continue;
      if (!target[field].some(e => itemValue(e) === val)) {
        target[field].push(item);
      }
    }
    target[field].sort((a, b) => (a?.captured_at || '').localeCompare(b?.captured_at || ''));
    if (target[field].length > 15) target[field] = target[field].slice(-15);
  }

  for (const field of DATED_SCALARS) {
    const srcDate = source[`${field}_updated_at`] || '';
    const tgtDate = target[`${field}_updated_at`] || '';
    if (source[field] && (!target[field] || srcDate > tgtDate)) {
      target[field] = source[field];
      if (srcDate) target[`${field}_updated_at`] = srcDate;
    }
  }

  const simpleScalars = ['name', 'age', 'location', 'addiction_type', 'substance_history',
    'previous_quit_attempts', 'preferred_coping_style', 'response_preference', 'emotional_patterns'];
  for (const field of simpleScalars) {
    if (source[field] && !target[field]) target[field] = source[field];
    if (source[field] && target[field] && String(source[field]).length > String(target[field]).length) {
      target[field] = source[field];
    }
  }

  // Merge risk windows by hour+day_of_week
  const riskMap = new Map();
  for (const rw of (target.risk_windows || [])) {
    riskMap.set(`${rw.hour}:${rw.day_of_week}`, rw);
  }
  for (const rw of (source.risk_windows || [])) {
    const key = `${rw.hour}:${rw.day_of_week}`;
    const existing = riskMap.get(key);
    if (existing) {
      existing.weight = Math.max(existing.weight || 0, rw.weight || 0);
    } else {
      riskMap.set(key, rw);
    }
  }
  target.risk_windows = Array.from(riskMap.values());

  // Merge life_architecture
  if (source.life_architecture) {
    if (!target.life_architecture) target.life_architecture = {};
    if (source.life_architecture.urge_model && !target.life_architecture.urge_model) {
      target.life_architecture.urge_model = source.life_architecture.urge_model;
    }
    for (const field of LIFE_ARCH_ARRAYS) {
      if (!Array.isArray(target.life_architecture[field])) target.life_architecture[field] = [];
      for (const item of (source.life_architecture[field] || [])) {
        const itemStr = typeof item === 'string' ? item : JSON.stringify(item);
        const isDup = target.life_architecture[field].some(existing => {
          const existStr = typeof existing === 'string' ? existing : JSON.stringify(existing);
          return existStr === itemStr;
        });
        if (!isDup) target.life_architecture[field].push(item);
      }
    }
  }

  // Merge schedule_model
  if (source.schedule_model) {
    if (!target.schedule_model) {
      target.schedule_model = { routine_blocks: [], vulnerability_windows: [], life_change_watch: [] };
    }
    for (const field of SCHEDULE_MODEL_ARRAYS) {
      if (!Array.isArray(target.schedule_model[field])) target.schedule_model[field] = [];
      for (const item of (source.schedule_model[field] || [])) {
        const itemStr = JSON.stringify(item);
        const isDup = target.schedule_model[field].some(existing => JSON.stringify(existing) === itemStr);
        if (!isDup) target.schedule_model[field].push(item);
      }
    }
  }

  saveProfile(targetId);
  console.log(`[ContextAgent] Merged ${sourceId} into ${targetId}: ${target.session_count} total sessions`);
  return target;
}
