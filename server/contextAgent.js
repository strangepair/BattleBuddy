/**
 * Background Context Agent — runs Sonnet in parallel to extract and maintain
 * a living user profile from the ongoing conversation.
 *
 * Architecture:
 *   Real-time agent (Haiku) ←→ User
 *         ↓ (messages stream in)
 *   Context Agent (Sonnet) — analyzes, extracts facts, updates profile
 *         ↓
 *   Context Store (in-memory + disk) — the real-time agent reads this
 *
 * The context agent never touches the conversation. It only observes and writes.
 *
 * Array items are stored as { value: "...", captured_at: "ISO timestamp" }
 * so BB can reference when something was learned: "you mentioned this last Tuesday."
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

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

// Map of user ID aliases — redirects old IDs to the canonical one
const USER_ALIASES = {
  'default': 'user-1782351957094',
  'user-1782249813276': 'user-1782351957094',
};

export function resolveUserId(userId) {
  return USER_ALIASES[userId] || userId;
}

function getStorePath(userId) {
  return resolve(STORE_DIR, `${userId}.json`);
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
 * Migrate a profile from plain-string arrays to timestamped objects.
 * Idempotent — safe to call on already-migrated profiles.
 */
function migrateProfile(profile) {
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
  return profile;
}

export function loadProfile(rawUserId) {
  const userId = resolveUserId(rawUserId);
  if (profiles[userId]) return profiles[userId];

  const path = getStorePath(userId);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      profiles[userId] = migrateProfile(raw);
      return profiles[userId];
    } catch {}
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
    session_count: 0,
    last_updated: null,
    recent_insights: [],
    next_session_hints: [],
    user_quotes: [],
    unknowns: [],
    risk_windows: [],
    activity_log: [],
  };
  return profiles[userId];
}

function saveProfile(userId) {
  const profile = profiles[userId];
  if (!profile) return;

  profile.last_updated = new Date().toISOString();

  try { mkdirSync(STORE_DIR, { recursive: true }); } catch {}

  writeFileSync(getStorePath(userId), JSON.stringify(profile, null, 2));
}

/**
 * Format a relative time string from an ISO timestamp.
 */
/**
 * Parse a clock time string ("6:35 AM", "11:32 PM") into minutes since midnight.
 * Used to sort activity log entries chronologically within a day.
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
  formatArray('Coping strategies', p.coping_strategies, 5);

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

  // The chronological activity timeline — BB can recite this back precisely
  if (p.activity_log && p.activity_log.length > 0) {
    const byDate = {};
    for (const ev of p.activity_log) {
      const d = ev.date || 'undated';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(ev);
    }
    const dates = Object.keys(byDate).sort().slice(-3); // last 3 days
    const lines = dates.map(d => {
      const events = byDate[d]
        .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))
        .map(ev => `${ev.time} — ${ev.event}${ev.type && ev.type !== 'other' ? ` [${ev.type}]` : ''}`);
      const label = d === 'undated' ? '' : `${d}: `;
      return `${label}${events.join(' → ')}`;
    });
    parts.push(`ACTIVITY TIMELINE (the user's logged day-by-day record — reference this precisely, with exact times, when they ask what you remember): ${lines.join(' || ')}`);
  }

  if (p.session_outcomes && p.session_outcomes.length > 0) {
    const recent = p.session_outcomes.slice(-10);
    const resisted = recent.filter(o => o.outcome === 'resisted').length;
    const gaveIn = recent.filter(o => o.outcome === 'gave_in').length;
    parts.push(`SESSION OUTCOMES (last ${recent.length}): ${resisted} resisted, ${gaveIn} gave in.`);
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
  return parts.join(' ');
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
  // (show string values, not the timestamped objects)
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

${isSessionEnd ? 'This is the end of a session. Generate next_session_hints — specific things to follow up on.' : 'This is a mid-session update.'}

CRITICAL — CORRECTIONS OVERWRITE OLD DATA:
If the user corrects something previously in the profile, return the CORRECTED value for that field. Do NOT append "user corrected this" — just return the right answer. The merge logic will overwrite the old value.
Example: if profile says "son quit smoking" but user says "my son never smoked, he vapes" → return family: "son vapes, never smoked" — not "son quit smoking BUT user corrected this to say he never smoked."

EXTRACTION RULES — be LITERAL and SPECIFIC:
- QUOTE the user's exact words when they describe feelings, metaphors, or experiences. Don't paraphrase.
  BAD: "describes addiction using a prison metaphor"
  GOOD: "said 'the urge feels like a warden — I've been in the prison so long I'm like one of those old guys who gets released and doesn't know what to do in the real world'"
- Use EXACT numbers. Don't round or approximate.
  BAD: "approximately 36 years of smoking"
  GOOD: "started smoking at age 9, now 45 — 36 years"
- Capture SPECIFIC names, products, books, medications, people.
  BAD: "tried pharmaceutical cessation"
  GOOD: "tried Chantix — took it for 6 days to fill receptors"
- For health: quote their exact symptoms.
  BAD: "lung issues"
  GOOD: "has a smoker's cough, said 'my lungs are telling me it's time'"
- For family: capture relationships with detail.
  BAD: "has a son"
  GOOD: "son quit smoking 18 months ago, quit vaping 6 months ago — his journey is inspiring user"
- For motivations: capture the WHY in their words.
- For life_context: capture anything personal — job, hobbies, daily routine, stress sources, relationships.
- For recent_insights: capture the user's own realizations in THEIR language.
- For next_session_hints: be specific — "ask about X" not "explore themes."

UNKNOWNS AND ANSWERS:
- If the user mentions something (a concept, a rule, a method, a person) that BB doesn't know about and the user doesn't explain → add it to "unknowns" array. Example: user says "remember the rule of three?" and doesn't explain → unknowns: ["the rule of three — user referenced it but never explained what it is"]
- If the user ANSWERS a previous unknown (explains something that was in the unknowns list) → add the explanation to the appropriate field (life_context, coping_strategies, etc.) AND add a "resolved_unknowns" entry so we can remove it from unknowns. Example: user explains the rule of three → coping_strategies: ["rule of three: [their explanation]"], resolved_unknowns: ["the rule of three"]
- If BB asks the user something and the user answers → capture that answer as a new fact in the relevant field. Don't let answers to questions evaporate.

TIME-OF-DAY PATTERNS — RISK WINDOWS:
- If the user mentions a specific time of day in relation to cravings, smoking, triggers, or vulnerability, extract it as a risk_window object.
- Format: { "hour": 14, "day_of_week": null, "weight": 0.8, "source": "mentioned afternoon cravings after lunch" }
- hour: 0-23 (24h format). day_of_week: 0=Sunday through 6=Saturday, or null if not day-specific.
- weight: 0.0-1.0 (how strong the signal is — direct statement "I always smoke at 3pm" = 1.0, indirect hint "afternoons are hard" = 0.5)
- Capture morning routines, post-meal times, commute windows, evening wind-down, bedtime — any time the user associates with their habit.
- If the user logs a cigarette or craving, note the time it happened as a risk window.
- If the user logs a NON-smoking moment at a previously risky time, note it with lower weight (the pattern may be changing).

ACTIVITY LOG — THE CHRONOLOGICAL TIMELINE (CRITICAL):
This user is logging their day moment by moment. They expect BB to remember the timeline precisely — "first cigarette at 6:35, gym at 8:15, no cigarette on the drive home." Every concrete activity, event, cigarette, resist, meal, gym session, work block, or mood the user reports must be captured as an activity_log entry with its ACTUAL clock time (using the local time provided above).
- Format: { "time": "6:35 AM", "date": "${localDate}", "event": "had first cigarette of the day", "type": "smoke" }
- type is one of: smoke, resist, craving, gym, work, meal, sleep, mood, social, other
- Use the user's EXACT words for the event when possible.
- If they report a cigarette → type "smoke". If they report resisting an urge → type "resist". If they report a craving they're sitting with → type "craving". A non-smoking activity (gym, working, eating) → the appropriate type.
- ALWAYS include the time. If the user didn't state a time, use the current local time provided above.
- This is the most important extraction for this user. Be precise and complete.

Return a JSON object with ONLY fields that have NEW information. For arrays, return only NEW items to add (as plain strings — the system will add timestamps automatically). EXCEPTION: activity_log and risk_windows items are objects, return them as objects per their format above.

Available fields:
name, age, location, occupation, family, addiction_type, substance_history, daily_usage,
quit_reason, health_concerns, previous_quit_attempts, longest_quit,
triggers (array), coping_strategies (array), what_works (array), what_doesnt_work (array),
motivations (array), life_context (array), preferred_coping_style, response_preference,
emotional_patterns, next_session_hints (array), recent_insights (array),
user_quotes (array) — memorable things the user said that reveal who they are,
unknowns (array) — things the user mentioned but never explained,
resolved_unknowns (array) — unknowns that were explained this session (will be removed from unknowns list),
risk_windows (array of objects) — time-of-day vulnerability patterns: { hour, day_of_week, weight, source },
activity_log (array of objects) — chronological events with clock times: { time, date, event, type }

Return ONLY valid JSON. No markdown, no explanation.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '{}';
    console.log(`[ContextAgent] Raw response (${text.length} chars):`, text.substring(0, 300));
    let updates;
    try {
      updates = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { updates = JSON.parse(match[0]); } catch { updates = {}; }
      } else {
        updates = {};
      }
    }

    // Merge updates into profile
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) continue;
      if (key === 'resolved_unknowns') continue;
      if (key === 'risk_windows' || key === 'activity_log') continue; // handled separately below

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
            logged_at: sessionTimestamp,
          });
        }
      }
      // Sort chronologically by date then time
      profile.activity_log.sort((a, b) => {
        const da = `${a.date} ${a.time}`;
        const db = `${b.date} ${b.time}`;
        return da.localeCompare(db);
      });
      // Keep last 60 events (several days of activity)
      if (profile.activity_log.length > 60) {
        profile.activity_log = profile.activity_log.slice(-60);
      }
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
    }

    // Keep arrays manageable — cap at 10, keep most recent
    for (const field of TIMESTAMPED_ARRAYS) {
      if (profile[field] && profile[field].length > 10) {
        profile[field] = profile[field].slice(-10);
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
    if (target[field].length > 10) target[field] = target[field].slice(-10);
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

  saveProfile(targetId);
  console.log(`[ContextAgent] Merged ${sourceId} into ${targetId}: ${target.session_count} total sessions`);
  return target;
}

