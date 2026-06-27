#!/usr/bin/env node

/**
 * Profile Migration: v0.2 → v0.3
 *
 * Backfills the life_architecture schema and pgvector embeddings from
 * existing profile data. Designed for Mike's 80+ session profile but
 * works on any user's data.
 *
 * What it does:
 *   1. Merges any alias profiles (default, user-1782249813276) into the canonical ID
 *   2. Reads triggers, coping_strategies, what_works, life_context, activity_log
 *   3. Classifies each into life_architecture fields via keyword matching
 *   4. Backfills pgvector via embedAndStore() for semantic retrieval
 *   5. Writes the enriched profile back — never deletes old fields
 *
 * Usage: node server/migrations/migrate_profile_to_v3.js [--dry-run] [--skip-vectors]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..');
const STORE_DIR = process.env.CONTEXT_STORE_DIR || resolve(SERVER_DIR, 'context-store');

// Load .env
const envPath = resolve(SERVER_DIR, '.env');
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

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_VECTORS = process.argv.includes('--skip-vectors');
const CANONICAL_USER = 'user-1782351957094';
const ALIAS_IDS = ['default', 'user-1782249813276'];
const LIVE_SERVER = process.env.LIVE_SERVER || 'https://bb-server-production-a849.up.railway.app';

// ─── Keyword classifiers ──────────────────────────────────────────────────────

const TRIGGER_KEYWORDS = [
  'trigger', 'urge fired', 'craving', 'tempt', 'urge hit',
  'want to smoke', 'reach for', 'light up',
];

const FLOW_STATE_KEYWORDS = [
  'sculpt', 'drawing', 'VR', 'immersion', 'absorbed', 'flow',
  'creative', 'art', 'don\'t get an urge', 'doesn\'t get urge',
  'complete urge suppression', 'no urges while',
];

const RISK_SPACE_KEYWORDS = [
  'outdoor smoking spot', 'patio', 'smoking area', 'smoking spot',
  'outside to smoke', 'go smoke there', 'car', 'drive',
  'enclosed space', 'leave the house',
];

const ORAL_HABIT_KEYWORDS = [
  'seeds', 'gum', 'gatorade', 'coffee', 'oral', 'chew',
  'mouth', 'hand-to-mouth',
];

const TRANSITION_KEYWORDS = [
  'transition', 'exit', 'leaving', 'finishing', 'after',
  'between tasks', 'gear-shift', 'blank space', 'gap',
  'break', 'post-', 'pre-',
];

const RESISTANCE_KEYWORDS = [
  'architectural friction', 'left cigarettes at home', 'physical separation',
  'redirect', 'shower', 'gym', 'walk', 'displacement',
  'breathing', 'rule of three', 'seeds', 'distraction',
  'talking to BB', 'talking to BattleBuddy',
];

const SOCIAL_KEYWORDS = [
  'social', 'with friends', 'people', 'drinking', 'bar',
  'work break', 'coworker', 'son', 'Alec',
];

function extractValue(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && item.value) return item.value;
  return '';
}

function matchesAny(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function extractIntensity(text) {
  const match = text.match(/intensity\s*[:=]?\s*(\d+)/i);
  if (match) return parseInt(match[1], 10);
  if (/always|every time|consistently|confirmed/i.test(text)) return 8;
  if (/often|usually|frequently|pattern/i.test(text)) return 6;
  if (/sometimes|occasional/i.test(text)) return 4;
  return 5; // default
}

function extractTriggerName(text) {
  // Try to extract a short trigger name from the description
  const patterns = [
    /^([^—]+?)(?:\s*—)/,     // "break-destination trigger — ..."
    /^([^:]+?)(?:\s*:)/,      // "morning drive routine: ..."
    /^(.{10,60}?)(?:\s*when\s)/i, // "X when Y"
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].trim();
  }
  return text.slice(0, 80);
}

function extractContext(text) {
  // Pull out time/place context
  const timeMatch = text.match(/at (?:approximately )?(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  const placeMatch = text.match(/(?:at the |at |in the |from |leaving |exiting )(gym|house|car|park|home|work|store|patio|smoking spot|creative workspace)/i);
  const parts = [];
  if (timeMatch) parts.push(`at ${timeMatch[1]}`);
  if (placeMatch) parts.push(`at/near ${placeMatch[1]}`);
  return parts.join(', ') || null;
}

// ─── Profile merger ──────────────────────────────────────────────────────────

function loadProfileFile(userId) {
  const path = resolve(STORE_DIR, `${userId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

function mergeIntoTarget(target, source) {
  if (!source) return;

  const TIMESTAMPED_ARRAYS = [
    'triggers', 'coping_strategies', 'what_works', 'what_doesnt_work',
    'motivations', 'life_context', 'recent_insights', 'next_session_hints',
    'user_quotes', 'unknowns',
  ];

  // Merge session counts
  target.session_count = Math.max(target.session_count || 0, source.session_count || 0);

  // Merge timestamped arrays — dedup by value
  for (const field of TIMESTAMPED_ARRAYS) {
    if (!Array.isArray(target[field])) target[field] = [];
    const sourceArr = source[field] || [];
    const existingVals = new Set(target[field].map(i => extractValue(i)));

    for (const item of sourceArr) {
      const val = extractValue(item);
      if (val && !existingVals.has(val)) {
        target[field].push(typeof item === 'string'
          ? { value: item, captured_at: source.last_updated || new Date().toISOString() }
          : item
        );
        existingVals.add(val);
      }
    }
  }

  // Merge scalar fields — longer/newer wins
  const scalars = ['name', 'age', 'location', 'occupation', 'family', 'addiction_type',
    'substance_history', 'daily_usage', 'quit_reason', 'health_concerns',
    'previous_quit_attempts', 'longest_quit', 'preferred_coping_style',
    'response_preference', 'emotional_patterns'];

  for (const field of scalars) {
    if (source[field] && (!target[field] || String(source[field]).length > String(target[field]).length)) {
      target[field] = source[field];
    }
  }

  // Merge risk_windows
  if (source.risk_windows) {
    if (!Array.isArray(target.risk_windows)) target.risk_windows = [];
    for (const rw of source.risk_windows) {
      const exists = target.risk_windows.some(
        t => t.hour === rw.hour && t.day_of_week === rw.day_of_week
      );
      if (!exists) target.risk_windows.push(rw);
    }
  }

  // Merge activity_log
  if (source.activity_log) {
    if (!Array.isArray(target.activity_log)) target.activity_log = [];
    for (const ev of source.activity_log) {
      const exists = target.activity_log.some(
        t => t.date === ev.date && t.time === ev.time && t.event === ev.event
      );
      if (!exists) target.activity_log.push(ev);
    }
  }

  // Merge session_outcomes
  if (source.session_outcomes) {
    if (!Array.isArray(target.session_outcomes)) target.session_outcomes = [];
    for (const so of source.session_outcomes) {
      const exists = target.session_outcomes.some(
        t => t.timestamp === so.timestamp && t.outcome === so.outcome
      );
      if (!exists) target.session_outcomes.push(so);
    }
  }
}

// ─── Life architecture builder ─────────────────────────────────────────────

function buildLifeArchitecture(profile) {
  const la = {
    trigger_taxonomy: [],
    flow_state_activities: [],
    physical_risk_spaces: [],
    oral_habit_pairs: [],
    transition_patterns: [],
    urge_model: null,
    resistance_strategies: [],
    social_contexts: [],
  };

  const seen = {
    triggers: new Set(),
    flows: new Set(),
    spaces: new Set(),
    oral: new Set(),
    transitions: new Set(),
    resistance: new Set(),
    social: new Set(),
  };

  function addUnique(set, arr, item) {
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (key.length < 5 || seen[set].has(key)) return;
    seen[set].add(key);
    arr.push(item);
  }

  // ─── Process triggers array ──────────────────────────────────────────────
  for (const raw of (profile.triggers || [])) {
    const text = extractValue(raw);
    if (!text) continue;

    const entry = {
      trigger: extractTriggerName(text),
      context: extractContext(text) || text.slice(0, 120),
      intensity: extractIntensity(text),
      verified: true,
      source_description: text,
    };
    addUnique('triggers', la.trigger_taxonomy, entry);

    // Also classify into other buckets if applicable
    if (matchesAny(text, FLOW_STATE_KEYWORDS)) {
      addUnique('flows', la.flow_state_activities, {
        activity: extractTriggerName(text),
        note: 'exit from this activity triggers smoking',
      });
    }
    if (matchesAny(text, RISK_SPACE_KEYWORDS)) {
      addUnique('spaces', la.physical_risk_spaces, {
        space: extractTriggerName(text),
        note: text.slice(0, 120),
      });
    }
    if (matchesAny(text, TRANSITION_KEYWORDS)) {
      addUnique('transitions', la.transition_patterns, {
        value: extractTriggerName(text),
        note: text.slice(0, 120),
      });
    }
  }

  // ─── Process coping strategies ──────────────────────────────────────────
  for (const raw of (profile.coping_strategies || [])) {
    const text = extractValue(raw);
    if (!text) continue;

    if (matchesAny(text, FLOW_STATE_KEYWORDS)) {
      addUnique('flows', la.flow_state_activities, {
        activity: extractTriggerName(text),
        note: 'suppresses urges during engagement',
      });
    }
    if (matchesAny(text, ORAL_HABIT_KEYWORDS)) {
      addUnique('oral', la.oral_habit_pairs, {
        value: extractTriggerName(text),
        note: text.slice(0, 120),
      });
    }
    if (matchesAny(text, RESISTANCE_KEYWORDS)) {
      addUnique('resistance', la.resistance_strategies, {
        strategy: extractTriggerName(text),
        note: text.slice(0, 120),
        verified_effective: true,
      });
    }
    if (matchesAny(text, TRANSITION_KEYWORDS)) {
      addUnique('transitions', la.transition_patterns, {
        value: extractTriggerName(text),
        note: text.slice(0, 120),
      });
    }
    if (matchesAny(text, RISK_SPACE_KEYWORDS)) {
      addUnique('spaces', la.physical_risk_spaces, {
        space: extractTriggerName(text),
        note: text.slice(0, 120),
      });
    }
  }

  // ─── Process what_works ─────────────────────────────────────────────────
  for (const raw of (profile.what_works || [])) {
    const text = extractValue(raw);
    if (!text) continue;

    if (matchesAny(text, RESISTANCE_KEYWORDS) || matchesAny(text, FLOW_STATE_KEYWORDS)) {
      addUnique('resistance', la.resistance_strategies, {
        strategy: extractTriggerName(text),
        note: text.slice(0, 120),
        verified_effective: true,
      });
    }
  }

  // ─── Process life_context for location/social data ─────────────────────
  for (const raw of (profile.life_context || [])) {
    const text = extractValue(raw);
    if (!text) continue;

    if (matchesAny(text, RISK_SPACE_KEYWORDS)) {
      addUnique('spaces', la.physical_risk_spaces, {
        space: extractTriggerName(text),
        note: text.slice(0, 120),
      });
    }
    if (matchesAny(text, SOCIAL_KEYWORDS)) {
      addUnique('social', la.social_contexts, {
        value: extractTriggerName(text),
        note: text.slice(0, 120),
      });
    }
  }

  // ─── Urge model — look for somatic/metaphorical descriptions ───────────
  // Priority: triggers with somatic keywords > user quotes about urge feel
  const somaticDescriptions = [];
  const metaphorDescriptions = [];

  for (const raw of (profile.triggers || [])) {
    const text = extractValue(raw);
    if (/somatic|pathway|physical route|esophagus|chest/i.test(text)) {
      somaticDescriptions.push(text);
    }
  }

  for (const raw of (profile.user_quotes || [])) {
    const text = extractValue(raw);
    if (/undercurrent|resonan/i.test(text)) {
      metaphorDescriptions.push(text);
    }
  }

  // Somatic descriptions win — extract the quoted user language
  const urgeSource = somaticDescriptions[0] || metaphorDescriptions[0];
  if (urgeSource) {
    const quotedPhrase = urgeSource.match(/['"]([^'"]{15,})['"]/);
    la.urge_model = quotedPhrase ? quotedPhrase[1] : urgeSource.slice(0, 200);
  }

  // ─── Hardcoded enrichments from known profile data ─────────────────────
  // These are facts deeply established across 80+ sessions that keyword
  // matching alone might miss or fragment.

  // Ensure key flow states are captured
  const knownFlows = [
    { activity: 'sculpting', note: 'complete urge suppression during creative absorption' },
    { activity: 'drawing', note: 'complete urge suppression during creative absorption' },
    { activity: 'VR immersion', note: 'complete urge suppression; exit triggers smoking' },
    { activity: 'gym/workout', note: 'physical activity redirects urge energy' },
    { activity: 'walking Butter at Eisenhower Park', note: 'post-gym routine, dog walk at Lake Hefner' },
  ];
  for (const flow of knownFlows) {
    addUnique('flows', la.flow_state_activities, flow);
  }

  // Ensure key risk spaces
  const knownSpaces = [
    { space: 'outdoor smoking spot', note: 'conditioned destination — exit from house/car leads here' },
    { space: 'car (driving)', note: 'morning drive routine involves smoking as inherent component' },
    { space: 'house exit', note: 'physical exit from enclosed space initiates smoking ritual' },
  ];
  for (const space of knownSpaces) {
    addUnique('spaces', la.physical_risk_spaces, space);
  }

  // Ensure key oral substitutes
  const knownOral = [
    { value: 'seeds (sunflower)', note: 'primary oral substitute; stops at store to restock mid-drive when out' },
  ];
  for (const oral of knownOral) {
    addUnique('oral', la.oral_habit_pairs, oral);
  }

  // Ensure key resistance strategies
  const knownStrategies = [
    { strategy: 'architectural friction — leaving cigarettes at home', note: 'physical separation creates time-and-effort barrier', verified_effective: true },
    { strategy: 'urge-to-gym redirect', note: 'physical displacement as urge interrupt', verified_effective: true },
    { strategy: 'Rule of Three breathing', note: 'three full cycles of four-beat breathing; immediate tactical support', verified_effective: true },
    { strategy: 'talking to BattleBuddy instead of smoking', note: 'conversation as primary distraction mechanism', verified_effective: true },
    { strategy: 'shower as break destination replacement', note: 'replaces smoking spot with functional hygiene activity', verified_effective: true },
    { strategy: 'post-quit break destination reframe', note: 'same exit behavior, same location, different activity (sun, walk, coffee, drawing)', verified_effective: true },
    { strategy: 'seeds as oral substitute on drives', note: 'deployed automatically on post-workout drives', verified_effective: true },
  ];
  for (const strat of knownStrategies) {
    addUnique('resistance', la.resistance_strategies, strat);
  }

  // Ensure key transition patterns
  const knownTransitions = [
    { value: 'activity completion → blank space → cigarette', note: 'when finishing any activity with no immediate next thing, brain reaches for cigarette as default filler' },
    { value: 'creative workspace exit → outdoor smoking spot', note: 'exiting sculpting/drawing/VR space fires break-destination-cigarette sequence' },
    { value: 'house/car exit → smoking spot', note: 'physical exit from enclosed space IS the start of the smoking ritual' },
    { value: 'morning wake → pre-gym drive → cigarette(s)', note: 'morning routine bundle includes smoking as inherent component' },
    { value: 'patch removal (evening) → permission window', note: 'taking patch off is intentional choice point; smokes 2-3 after' },
  ];
  for (const trans of knownTransitions) {
    addUnique('transitions', la.transition_patterns, trans);
  }

  return la;
}

// ─── Vector backfill ──────────────────────────────────────────────────────

async function backfillVectors(userId, profile) {
  let embedAndStore;
  try {
    const mod = await import('../vectorStore.js');
    embedAndStore = mod.embedAndStore;
    if (!mod.isConfigured()) {
      console.log('  [vectors] OPENAI_API_KEY not configured, skipping vector backfill');
      return { embedded: 0, skipped: true };
    }
  } catch (e) {
    console.log(`  [vectors] Could not load vectorStore: ${e.message}`);
    return { embedded: 0, skipped: true };
  }

  let count = 0;
  const BATCH_DELAY_MS = 200; // rate limit courtesy

  async function embed(content, type) {
    if (!content || content.length < 15) return;
    try {
      await embedAndStore(userId, content, type);
      count++;
      if (count % 10 === 0) console.log(`  [vectors] Embedded ${count} items...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    } catch (e) {
      console.log(`  [vectors] Failed to embed: ${e.message}`);
    }
  }

  // Embed triggers
  for (const raw of (profile.triggers || [])) {
    await embed(extractValue(raw), 'trigger');
  }

  // Embed insights
  for (const raw of (profile.recent_insights || [])) {
    await embed(extractValue(raw), 'insight');
  }

  // Embed coping strategies
  for (const raw of (profile.coping_strategies || [])) {
    await embed(extractValue(raw), 'observation');
  }

  // Embed what works
  for (const raw of (profile.what_works || [])) {
    await embed(extractValue(raw), 'observation');
  }

  // Embed what doesn't work
  for (const raw of (profile.what_doesnt_work || [])) {
    await embed(extractValue(raw), 'observation');
  }

  // Embed life context
  for (const raw of (profile.life_context || [])) {
    await embed(extractValue(raw), 'observation');
  }

  // Embed motivations
  for (const raw of (profile.motivations || [])) {
    await embed(extractValue(raw), 'insight');
  }

  // Embed user quotes
  for (const raw of (profile.user_quotes || [])) {
    const text = extractValue(raw);
    if (text) await embed(`Mike said: "${text}"`, 'observation');
  }

  // Embed activity log entries (summarized)
  const activityLog = profile.activity_log || [];
  // Group by date for summary embedding
  const byDate = {};
  for (const ev of activityLog) {
    const d = ev.date || 'undated';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(ev);
  }
  for (const [date, events] of Object.entries(byDate)) {
    const summary = events.map(ev =>
      `${ev.time}: ${ev.event} [${ev.type || 'other'}]`
    ).join('; ');
    await embed(`Activity log ${date}: ${summary}`, 'session_summary');
  }

  // Embed next session hints
  for (const raw of (profile.next_session_hints || [])) {
    await embed(extractValue(raw), 'insight');
  }

  return { embedded: count, skipped: false };
}

// ─── Upload to live server ──────────────────────────────────────────────

async function uploadToLiveServer(userId, profile) {
  try {
    const res = await fetch(`${LIVE_SERVER}/context/profile/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`  [upload] Profile uploaded to live server: ${data.name}, ${data.session_count} sessions`);
      return true;
    }
    console.log(`  [upload] Server responded:`, data);
    return false;
  } catch (e) {
    console.log(`  [upload] Could not reach live server: ${e.message}`);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BattleBuddy Profile Migration: v0.2 → v0.3');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();

  if (DRY_RUN) console.log('  *** DRY RUN — no files will be written ***\n');
  if (SKIP_VECTORS) console.log('  *** Skipping vector backfill ***\n');

  // Step 1: Load or fetch canonical profile
  console.log('Step 1: Load profiles');
  console.log('─────────────────────');

  let canonical = loadProfileFile(CANONICAL_USER);
  if (!canonical) {
    console.log(`  ${CANONICAL_USER}.json not found locally, fetching from live server...`);
    try {
      const res = await fetch(`${LIVE_SERVER}/context/profile/${CANONICAL_USER}`);
      const data = await res.json();
      if (data.profile) {
        canonical = data.profile;
        console.log(`  Fetched: ${canonical.session_count} sessions, ${canonical.name}`);
      }
    } catch (e) {
      console.log(`  Could not fetch from live server: ${e.message}`);
    }
  } else {
    console.log(`  Loaded ${CANONICAL_USER}: ${canonical.session_count} sessions`);
  }

  if (!canonical) {
    console.error('  ERROR: No canonical profile found. Cannot proceed.');
    process.exit(1);
  }

  // Step 2: Merge aliases
  console.log();
  console.log('Step 2: Merge alias profiles');
  console.log('────────────────────────────');

  for (const aliasId of ALIAS_IDS) {
    const alias = loadProfileFile(aliasId);
    if (alias) {
      const before = canonical.triggers?.length || 0;
      mergeIntoTarget(canonical, alias);
      const after = canonical.triggers?.length || 0;
      console.log(`  Merged ${aliasId}: +${after - before} triggers, session_count=${canonical.session_count}`);
    } else {
      console.log(`  ${aliasId}: not found locally, skipping`);
    }
  }

  // Step 3: Build life_architecture
  console.log();
  console.log('Step 3: Build life_architecture');
  console.log('───────────────────────────────');

  const la = buildLifeArchitecture(canonical);
  canonical.life_architecture = la;

  console.log(`  trigger_taxonomy:       ${la.trigger_taxonomy.length} entries`);
  console.log(`  flow_state_activities:  ${la.flow_state_activities.length} entries`);
  console.log(`  physical_risk_spaces:   ${la.physical_risk_spaces.length} entries`);
  console.log(`  oral_habit_pairs:       ${la.oral_habit_pairs.length} entries`);
  console.log(`  transition_patterns:    ${la.transition_patterns.length} entries`);
  console.log(`  resistance_strategies:  ${la.resistance_strategies.length} entries`);
  console.log(`  social_contexts:        ${la.social_contexts.length} entries`);
  console.log(`  urge_model:             ${la.urge_model ? `"${la.urge_model.slice(0, 80)}..."` : 'null'}`);

  // Step 4: Add last_session_at and daily_summaries if missing
  if (!canonical.last_session_at) {
    canonical.last_session_at = canonical.last_updated;
  }
  if (!Array.isArray(canonical.daily_summaries)) {
    canonical.daily_summaries = [];
  }

  // Ensure verified flag on existing activity_log entries
  if (canonical.activity_log) {
    for (const ev of canonical.activity_log) {
      if (ev.verified === undefined) ev.verified = false;
    }
  }

  // Step 5: Write profile
  console.log();
  console.log('Step 4: Write enriched profile');
  console.log('──────────────────────────────');

  const profileJson = JSON.stringify(canonical, null, 2);
  console.log(`  Profile size: ${profileJson.length} chars (${Math.round(profileJson.length / 1024)}KB)`);

  if (!DRY_RUN) {
    try { mkdirSync(STORE_DIR, { recursive: true }); } catch {}
    writeFileSync(resolve(STORE_DIR, `${CANONICAL_USER}.json`), profileJson);
    console.log(`  Written to ${STORE_DIR}/${CANONICAL_USER}.json`);

    // Also try uploading to live server
    await uploadToLiveServer(CANONICAL_USER, canonical);
  } else {
    console.log('  [dry-run] Would write to disk and upload to live server');
  }

  // Step 6: Vector backfill
  console.log();
  console.log('Step 5: Vector backfill (pgvector)');
  console.log('──────────────────────────────────');

  if (SKIP_VECTORS || DRY_RUN) {
    const totalItems = (canonical.triggers?.length || 0)
      + (canonical.recent_insights?.length || 0)
      + (canonical.coping_strategies?.length || 0)
      + (canonical.what_works?.length || 0)
      + (canonical.what_doesnt_work?.length || 0)
      + (canonical.life_context?.length || 0)
      + (canonical.motivations?.length || 0)
      + (canonical.user_quotes?.length || 0)
      + (canonical.next_session_hints?.length || 0)
      + Object.keys(
          (canonical.activity_log || []).reduce((acc, ev) => {
            acc[ev.date || 'undated'] = true; return acc;
          }, {})
        ).length;
    console.log(`  ${DRY_RUN ? '[dry-run]' : '[skipped]'} Would embed ~${totalItems} items into pgvector`);
  } else {
    const result = await backfillVectors(CANONICAL_USER, canonical);
    if (result.skipped) {
      console.log('  Skipped (no API key configured)');
    } else {
      console.log(`  Embedded ${result.embedded} items into pgvector`);
    }
  }

  // Summary
  console.log();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Migration complete!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log(`  User:            ${canonical.name} (${CANONICAL_USER})`);
  console.log(`  Sessions:        ${canonical.session_count}`);
  console.log(`  Triggers:        ${canonical.triggers?.length || 0}`);
  console.log(`  Life arch fields: ${Object.values(la).filter(v => Array.isArray(v) ? v.length > 0 : v !== null).length}/8`);
  console.log(`  Profile size:    ${Math.round(profileJson.length / 1024)}KB`);
  console.log();

  if (DRY_RUN) {
    console.log('  Re-run without --dry-run to apply changes.');
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
