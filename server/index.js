process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { sendPush, isQuietHours, pickNudgeMessage } from './notifications.js';
import { analyzeAndUpdate, buildProfileSummary, buildLifeArchitectureSummary, buildCurrentGoal, computeUsageStats, lookupProfileField, loadProfile, seedProfile, mergeProfiles, resolveUserId, saveRawTranscript, appendTranscriptMessages, replaceProfile, persistProfile } from './contextAgent.js';
import { embedAndStore, retrieveRelevant, isConfigured as isVectorConfigured } from './vectorStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dotenv dependency)
const envPath = resolve(__dirname, '.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
} catch {}

const client = new Anthropic();

// Shared Supabase client for the bb_events store (service-role — bypasses RLS,
// used only from this trusted server process). Node 20 has no native
// WebSocket global, which supabase-js's realtime client requires even though
// we only use REST (.from()) calls — pass the `ws` package explicitly so
// client construction doesn't throw on startup.
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    realtime: { transport: WebSocket },
  })
  : null;

// Path to the system prompt (read fresh on every call so agentDesignLoop
// updates go live without a redeploy)
const systemPromptPath = resolve(__dirname, 'prompts', 'system.battlebuddy.md');

const DEFAULT_TZ = 'America/Chicago';

// ─── Timezone helpers ────────────────────────────────────────────────────────
// bb_events stores UTC instants; "today" must be computed in the *user's* day,
// not the server's (Railway runs in UTC — a 7 PM Central cigarette is
// tomorrow's date in UTC).

function localDateInTz(timezone = DEFAULT_TZ, at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

function tzOffsetString(timezone = DEFAULT_TZ, at = new Date()) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at).find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00';
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return '+00:00';
    return `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}`;
  } catch {
    return '+00:00';
  }
}

/** UTC start/end instants of a local calendar day (YYYY-MM-DD) in a timezone. */
function dayRangeInTz(dateStr, timezone = DEFAULT_TZ) {
  const offset = tzOffsetString(timezone, new Date(`${dateStr}T12:00:00Z`));
  const start = new Date(`${dateStr}T00:00:00${offset}`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000 - 1);
  return { start, end };
}

/** Convert a profile-style local time ("3:30 PM" on "2026-07-02") to an ISO instant. */
function localTimeToIso(dateStr, timeStr, timezone = DEFAULT_TZ) {
  const m = (timeStr || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m || !dateStr) return null;
  let hour = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const offset = tzOffsetString(timezone, new Date(`${dateStr}T12:00:00Z`));
  const d = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00${offset}`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function formatLocalTime(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Chicago',
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Chicago',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return `${formatter.format(now)}, ${dateFormatter.format(now)}`;
  } catch {
    return new Date().toLocaleString();
  }
}

/**
 * Build the session context string for the {{session_context}} placeholder.
 * Tells the agent how long since last session and whether to skip greeting.
 */
function buildSessionContext(profile) {
  if (!profile || !profile.last_session_at) {
    return 'This is the first session with this user.';
  }

  const lastAt = new Date(profile.last_session_at).getTime();
  const now = Date.now();
  const gapMs = now - lastAt;
  const gapMinutes = Math.floor(gapMs / 60000);
  const gapHours = Math.floor(gapMinutes / 60);
  const gapDays = Math.floor(gapHours / 24);

  let gapStr;
  if (gapMinutes < 5) gapStr = 'just now';
  else if (gapMinutes < 60) gapStr = `${gapMinutes} minutes ago`;
  else if (gapHours < 24) gapStr = `${gapHours} hours ago`;
  else if (gapDays === 1) gapStr = 'yesterday';
  else gapStr = `${gapDays} days ago`;

  // Format last session time
  let lastTimeStr = '';
  try {
    lastTimeStr = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(profile.last_session_at));
  } catch {}

  let context = `Last session: ${gapStr}`;
  if (lastTimeStr && gapDays >= 1) context += ` (at ${lastTimeStr})`;
  context += '.';

  if (gapMinutes < 30) {
    context += ' This is a continuation of the same conversation — skip the greeting and pick up where you left off.';
  }

  return context;
}

function buildSystemPrompt(profile, triggerContext, recentHistory, timezone, lifeArchitecture, sessionContext, currentGoal, relevantMemories) {
  const localTime = formatLocalTime(timezone);
  const timeContext = `User's local time: ${localTime}.` +
    (triggerContext ? ` ${triggerContext}` : '');
  const systemPromptTemplate = readFileSync(systemPromptPath, 'utf-8');
  return systemPromptTemplate
    .replace('{{current_goal}}', currentGoal || 'Build a living map of this person through observation, not interrogation.')
    .replace('{{profile}}', profile || 'New user — no history yet.')
    .replace('{{trigger_context}}', timeContext)
    .replace('{{recent_history}}', recentHistory || 'First message in this session.')
    .replace('{{life_architecture}}', lifeArchitecture || 'Not yet discovered — learn through conversation.')
    .replace('{{session_context}}', sessionContext || 'No prior session data.')
    .replace('{{relevant_memories}}', relevantMemories || 'None retrieved for this turn.');
}

/**
 * Fetch memories relevant to the current message, capped so a slow Supabase
 * round-trip can never hold up the first token (latency is the product).
 */
async function fetchRelevantMemories(userId, queryText, timeoutMs = 800) {
  if (!queryText || !isVectorConfigured()) return null;
  try {
    const memories = await Promise.race([
      retrieveRelevant(userId, queryText, 5),
      new Promise(res => setTimeout(() => res(null), timeoutMs)),
    ]);
    if (!memories || memories.length === 0) return null;
    return memories
      .map(m => `- [${m.type}, ${new Date(m.created_at).toISOString().slice(0, 10)}] ${m.content}`)
      .join('\n');
  } catch {
    return null;
  }
}

// ─── bb_events tool ─────────────────────────────────────────────────────────
// Gives the agent a deterministic answer to "when was my last cigarette" /
// "how many today" instead of guessing from conversational memory.

const AGENT_TOOLS = [
  {
    name: 'get_usage_stats',
    description: "Query the user's smoking and urge event history from the database. Use this for ANY question about cigarette counts, timestamps, last cigarette time, gaps between cigarettes, urges resisted, or milestones. Returns authoritative data — never guess or recall from memory when you can call this tool.",
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: "Date to query in YYYY-MM-DD format, or 'today'. Omit to get most recent events across all dates.",
        },
        event_types: {
          type: 'array',
          items: { type: 'string' },
          description: "Filter by event types: 'cigarette', 'urge_resisted', 'urge_gave_in', 'milestone'. Omit for all types.",
        },
        limit: {
          type: 'integer',
          description: 'Max events to return (default 20, max 100)',
        },
      },
      required: [],
    },
  },
  {
    name: 'log_event',
    description: "Log a new smoking or urge event to the database on behalf of the user. Use this when the user mentions they just smoked, resisted an urge, gave in to an urge, or hit a milestone — and it hasn't been logged yet via the app's quick-log. Always confirm what you logged back to the user.",
    input_schema: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          enum: ['cigarette', 'urge_resisted', 'urge_gave_in', 'milestone'],
          description: 'The type of event to log',
        },
        occurred_at: {
          type: 'string',
          description: "ISO 8601 timestamp when the event occurred. Use current time if not specified by the user. If user says 'an hour ago', calculate the correct timestamp.",
        },
        notes: {
          type: 'string',
          description: "Optional context notes (e.g. 'post-gym', 'in the car', 'with coffee')",
        },
        milestone_label: {
          type: 'string',
          description: "For milestone events only: human-readable label like '24 hours smoke-free'",
        },
      },
      required: ['event_type', 'occurred_at'],
    },
  },
  {
    name: 'update_event',
    description: 'Correct or delete an existing event in the database. Use this when the user says an event was logged incorrectly — wrong type, wrong time, or it shouldn\'t have been logged at all. First call get_usage_stats to find the event ID, then call this to fix it. Tell the user what you changed.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'UUID of the event to update. Get this from get_usage_stats.',
        },
        action: {
          type: 'string',
          enum: ['update', 'delete'],
          description: "Whether to update the event's fields or delete it entirely",
        },
        event_type: {
          type: 'string',
          enum: ['cigarette', 'urge_resisted', 'urge_gave_in', 'milestone'],
          description: 'New event type (for update only)',
        },
        occurred_at: {
          type: 'string',
          description: 'Corrected ISO 8601 timestamp (for update only)',
        },
        notes: {
          type: 'string',
          description: 'Updated notes (for update only)',
        },
      },
      required: ['event_id', 'action'],
    },
  },
];

async function queryEvents(userId, { date, eventTypes, limit = 20, timezone = DEFAULT_TZ } = {}) {
  if (!supabase) return [];

  let query = supabase
    .from('bb_events')
    .select('id, event_type, occurred_at, metadata')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(Math.min(parseInt(limit, 10) || 20, 100));

  if (date) {
    const { start, end } = dayRangeInTz(date, timezone);
    query = query.gte('occurred_at', start.toISOString()).lte('occurred_at', end.toISOString());
  }

  if (eventTypes && eventTypes.length > 0) {
    query = query.in('event_type', eventTypes);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * One merged usage view served to BOTH modes (text tool + voice /context/stats)
 * so they can never disagree: the transactional event log is authoritative for
 * logged events; the profile activity timeline covers conversation-extracted
 * history that predates the log.
 */
async function buildUsageSummary(userId, timezone = DEFAULT_TZ) {
  const result = { profile_stats: null, event_log: null };
  try {
    result.profile_stats = computeUsageStats(userId, timezone);
  } catch (e) {
    result.profile_stats = { error: e.message };
  }
  try {
    const today = localDateInTz(timezone);
    const events = await queryEvents(userId, { date: today, limit: 100, timezone });
    result.event_log = { date: today, events, summary: summarizeEvents(events) };
  } catch (e) {
    result.event_log = { unavailable: true, error: e.message };
  }
  return result;
}

/**
 * Mirror conversation-extracted smoke/resist activity into bb_events so the
 * transactional log stays the single source of truth even when the user tells
 * BB about a cigarette instead of quick-logging it. Dedupes against anything
 * already logged within ±10 minutes of the same type.
 */
async function mirrorActivityToEvents(rawUserId, updates, timezone = DEFAULT_TZ) {
  if (!supabase || !updates || !Array.isArray(updates.activity_log)) return;
  const userId = resolveUserId(rawUserId);
  const TYPE_MAP = { smoke: 'cigarette', resist: 'urge_resisted' };

  for (const ev of updates.activity_log) {
    const eventType = TYPE_MAP[ev?.type];
    if (!eventType) continue;
    const occurredAt = localTimeToIso(ev.date, ev.time, timezone);
    if (!occurredAt) continue;

    try {
      const windowStart = new Date(new Date(occurredAt).getTime() - 10 * 60000).toISOString();
      const windowEnd = new Date(new Date(occurredAt).getTime() + 10 * 60000).toISOString();
      const { data: nearby } = await supabase
        .from('bb_events')
        .select('id')
        .eq('user_id', userId)
        .eq('event_type', eventType)
        .gte('occurred_at', windowStart)
        .lte('occurred_at', windowEnd)
        .limit(1);
      if (nearby && nearby.length > 0) continue;

      await supabase.from('bb_events').insert({
        user_id: userId,
        event_type: eventType,
        occurred_at: occurredAt,
        metadata: {
          source: 'extraction',
          verified: !!ev.verified,
          event: ev.event || null,
        },
      });
    } catch (e) {
      console.log(`[EventMirror] Skipped (${e.message})`);
    }
  }
}

function summarizeEvents(events) {
  const cigarettes = events.filter(e => e.event_type === 'cigarette');
  const lastCigarette = cigarettes[0] || null;
  const gapMinutes = lastCigarette
    ? Math.round((Date.now() - new Date(lastCigarette.occurred_at).getTime()) / 60000)
    : null;

  return {
    total_events: events.length,
    cigarette_count: cigarettes.length,
    last_cigarette_at: lastCigarette?.occurred_at || null,
    minutes_since_last_cigarette: gapMinutes,
    urges_resisted: events.filter(e => e.event_type === 'urge_resisted').length,
    urges_gave_in: events.filter(e => e.event_type === 'urge_gave_in').length,
  };
}

/** Shared correct/delete logic for the text tool and the voice /events/update endpoint. */
async function updateEvent(userId, { event_id, action, event_type, occurred_at, notes } = {}) {
  if (!supabase) return { error: 'Event store unavailable' };
  if (!event_id || !action) return { error: 'event_id and action required' };

  if (action === 'delete') {
    const { error } = await supabase.from('bb_events').delete().eq('id', event_id).eq('user_id', userId);
    return error ? { error: error.message } : { ok: true, deleted: event_id };
  }

  const updates = {};
  if (event_type) updates.event_type = event_type;
  if (occurred_at) updates.occurred_at = occurred_at;
  if (notes !== undefined && notes !== '') updates.metadata = { notes };

  const { error } = await supabase.from('bb_events').update(updates).eq('id', event_id).eq('user_id', userId);
  return error ? { error: error.message } : { ok: true, updated: event_id, changes: updates };
}

async function executeToolUse(toolUse, userId, timezone = DEFAULT_TZ) {
  if (toolUse.name === 'get_usage_stats') {
    try {
      const { date, event_types, limit } = toolUse.input || {};
      const queryDate = date === 'today' ? localDateInTz(timezone) : date;
      const events = await queryEvents(userId, { date: queryDate, eventTypes: event_types, limit, timezone });
      // Include the profile-derived stats too so text mode sees the same
      // merged picture the voice agent gets from /context/stats.
      let profileStats = null;
      try { profileStats = computeUsageStats(userId, timezone); } catch {}
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify({ events, summary: summarizeEvents(events), profile_stats: profileStats }),
      };
    } catch (err) {
      return { type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ error: err.message }), is_error: true };
    }
  }

  if (toolUse.name === 'log_event') {
    if (!supabase) {
      return { type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ error: 'Event store unavailable' }), is_error: true };
    }
    const { event_type, occurred_at, notes, milestone_label } = toolUse.input || {};

    const metadata = {};
    if (notes) metadata.notes = notes;
    if (milestone_label) metadata.label = milestone_label;

    const { data, error } = await supabase
      .from('bb_events')
      .insert({
        user_id: userId,
        event_type,
        occurred_at,
        metadata,
      })
      .select('id, occurred_at')
      .single();

    if (error) {
      return { type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ error: error.message }), is_error: true };
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify({ ok: true, id: data.id, occurred_at: data.occurred_at, event_type }),
    };
  }

  if (toolUse.name === 'update_event') {
    const { event_id, action, event_type, occurred_at, notes } = toolUse.input || {};
    const result = await updateEvent(userId, { event_id, action, event_type, occurred_at, notes });
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify(result),
      is_error: !!result.error,
    };
  }

  return { type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` }), is_error: true };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// Streams one agent turn to the client over SSE. When the model calls a tool
// (e.g. get_usage_stats), the loop executes it, feeds the result back, and
// keeps streaming — the client only ever sees text deltas and [DONE].
const TOOL_USE_MAX_ROUNDS = 3;

async function streamTextTurn(res, systemPrompt, conversationMessages, effectiveUserId, timezone = DEFAULT_TZ) {
  const FIRST_TOKEN_TIMEOUT_MS = 25000;
  let headersSent = false;

  // Runs one model turn, forwarding text deltas as they arrive. Returns the
  // accumulated final message, or null if the request already ended (timeout).
  const runStream = async (msgs) => {
    const streamAbort = new AbortController();
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools: AGENT_TOOLS,
      messages: msgs,
    }, { signal: streamAbort.signal });

    // Watchdog: abort if the model goes silent for too long. Reset on
    // every delta so a slow-but-steady stream isn't killed mid-response.
    let timedOut = false;
    const armWatchdog = () => setTimeout(() => {
      timedOut = true;
      streamAbort.abort();
    }, FIRST_TOKEN_TIMEOUT_MS);
    let watchdog = armWatchdog();

    // Wait for the first event before committing to SSE —
    // this lets pre-stream errors (billing, auth) return a proper HTTP status
    try {
      for await (const event of stream) {
        clearTimeout(watchdog);
        watchdog = armWatchdog();

        if (!headersSent) {
          res.writeHead(200, {
            ...CORS,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          headersSent = true;
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
      clearTimeout(watchdog);
    } catch (streamErr) {
      clearTimeout(watchdog);
      if (timedOut) {
        if (!headersSent) {
          res.writeHead(200, {
            ...CORS,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
        }
        res.write('data: {"type":"error","error":"Response timed out — please try again"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return null;
      }
      throw streamErr;
    }

    return stream.finalMessage();
  };

  let currentMessages = conversationMessages;
  let finalMessage = await runStream(currentMessages);
  if (!finalMessage) return; // timed out — response already ended

  let rounds = 0;
  while (finalMessage.stop_reason === 'tool_use' && rounds < TOOL_USE_MAX_ROUNDS) {
    rounds++;
    const toolUseBlocks = finalMessage.content.filter(b => b.type === 'tool_use');
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      toolResults.push(await executeToolUse(toolUse, effectiveUserId, timezone));
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: finalMessage.content },
      { role: 'user', content: toolResults },
    ];

    finalMessage = await runStream(currentMessages);
    if (!finalMessage) return;
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // ─── Usage stats tool endpoint — merged view (profile timeline + event log)
  // so voice mode answers from the same data as text mode's get_usage_stats.
  if (req.method === 'GET' && req.url.match(/^\/context\/stats\//)) {
    const parts = req.url.split('/context/stats/');
    const userId = decodeURIComponent((parts[1] || '').split('?')[0]);
    try {
      const stats = await buildUsageSummary(resolveUserId(userId), DEFAULT_TZ);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stats));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Profile field lookup tool endpoint (Bug C) ────────────────────────────
  if (req.method === 'GET' && req.url.match(/^\/context\/field\//)) {
    const urlParts = req.url.split('/context/field/');
    const remainder = decodeURIComponent(urlParts[1] || '');
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing field name. Use /context/field/{userId}/{field}' }));
    }
    const userId = remainder.slice(0, slashIdx);
    const field = remainder.slice(slashIdx + 1);
    try {
      const value = lookupProfileField(userId, field);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ field, value }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'POST' && req.url === '/session/turn') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { messages, profile, trigger_context, recent_history, userId, timezone } = JSON.parse(body);

      // Use the context agent's profile if available, fall back to client-provided.
      // Anonymous fallback must NOT be 'default' — that aliases to the founder's
      // profile (resolveUserId), which would hand his history to any client
      // that omits userId (e.g. a fresh install before auth hydration).
      const effectiveUserId = userId || `anon-${Date.now()}`;
      const contextProfile = buildProfileSummary(effectiveUserId);
      const finalProfile = (contextProfile && !contextProfile.includes('New user'))
        ? contextProfile
        : profile;

      const lifeArchitecture = buildLifeArchitectureSummary(effectiveUserId);
      const currentGoal = buildCurrentGoal(effectiveUserId);
      const agentProfile = loadProfile(effectiveUserId);
      const sessionContext = buildSessionContext(agentProfile);

      // Pull memories relevant to what the user just said (bounded at 800ms
      // so retrieval can never delay the first token past budget).
      const lastUserMessage = [...(messages || [])].reverse().find(m => m.role === 'user')?.content || '';
      const relevantMemories = await fetchRelevantMemories(resolveUserId(effectiveUserId), lastUserMessage);

      const systemPrompt = buildSystemPrompt(
        finalProfile,
        trigger_context ? JSON.stringify(trigger_context) : undefined,
        recent_history || messages?.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n'),
        timezone,
        lifeArchitecture,
        sessionContext,
        currentGoal,
        relevantMemories,
      );

      // Background fact extraction (non-blocking). Throttled to roughly every
      // third user turn — session end runs a full extraction anyway, so a
      // Sonnet call per turn was pure cost. The client sends the full history
      // with the new user message appended (odd lengths: 1, 3, 5, 7…), so
      // % 6 === 1 fires at 7, 13, 19… slice(-20) inside analyzeAndUpdate
      // still covers everything between throttle points.
      if (messages?.length >= 7 && messages.length % 6 === 1) {
        analyzeAndUpdate(effectiveUserId, messages, false, timezone)
          .then(updates => mirrorActivityToEvents(effectiveUserId, updates, timezone))
          .catch(() => {});
      }

      await streamTextTurn(res, systemPrompt, messages.map(m => ({
        role: m.role,
        content: m.content,
      })), resolveUserId(effectiveUserId), timezone);
    } catch (err) {
      console.error('Error:', err.message);
      if (!res.headersSent) {
        const status = err.message?.includes('credit balance') ? 503 : 500;
        res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/livekit/token') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { room, identity, context, sessionCount, profile, recentHistory, triggerContext, priorMessages, timezone } = JSON.parse(body);
      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;

      if (!apiKey || !apiSecret) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'LiveKit not configured' }));
      }

      const roomName = room || 'battlebuddy';
      const at = new AccessToken(apiKey, apiSecret, {
        identity: identity || `user-${Date.now()}`,
        metadata: JSON.stringify({
          context: context || 'fresh_session',
          sessionCount: sessionCount || 0,
          profile: profile || undefined,
          recentHistory: recentHistory || undefined,
          triggerContext: triggerContext || undefined,
          priorMessages: priorMessages || undefined,
        }),
      });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();

      // Anonymous fallback must not inherit the founder's profile via the
      // 'default' alias (see /session/turn note).
      const effectiveUserId = identity || `anon-${Date.now()}`;
      const contextProfile = buildProfileSummary(effectiveUserId);
      const finalProfile = (contextProfile && !contextProfile.includes('New user'))
        ? contextProfile
        : profile;

      console.log(`[Voice] User: ${effectiveUserId}`);
      console.log(`[Voice] Profile (${(finalProfile || '').length} chars): ${(finalProfile || '').substring(0, 200)}`);

      const lifeArchitecture = buildLifeArchitectureSummary(effectiveUserId);
      const currentGoal = buildCurrentGoal(effectiveUserId);
      const agentProfile = loadProfile(effectiveUserId);
      const sessionContext = buildSessionContext(agentProfile);

      const voiceSystemPrompt = buildSystemPrompt(
        finalProfile,
        triggerContext ? JSON.stringify(triggerContext) : undefined,
        priorMessages || recentHistory || undefined,
        timezone,
        lifeArchitecture,
        sessionContext,
        currentGoal,
      );

      try {
        console.log(`[Voice] System prompt: ${voiceSystemPrompt.length} chars`);
      } catch(e) { console.log('[Voice] Log error:', e.message); }

      // Extract name — check context agent first, then client profile
      let userName = agentProfile?.name || 'there';
      if (userName === 'there' && finalProfile) {
        const nameMatch = finalProfile.match(/Name:\s*([^.]+)/);
        if (nameMatch) userName = nameMatch[1].trim();
      }

      // Build the greeting instruction
      let greeting;
      if (context === 'switched_from_text' || priorMessages) {
        greeting = 'Casually acknowledge switching to voice and continue the conversation. One sentence.';
      } else if (agentProfile && agentProfile.session_count > 0) {
        const hints = agentProfile.next_session_hints || [];
        const hint = hints.length > 0 ? hints[0] : null;
        greeting = `Greet ${userName} warmly by name. You know them well — you've had ${agentProfile.session_count} conversations. `
          + `Reference ONE specific thing you know about them to show you remember. `
          + (hint ? `Suggested follow-up from last session: "${hint}". ` : '')
          + `Keep it to 2 sentences. Then wait.`;
      } else {
        greeting = `Say: 'Hey, ${userName}! How's it going?' and wait for their response.`;
      }

      // Dispatch the agent with the prompt and greeting baked in
      const { RoomServiceClient, AgentDispatchClient } = await import('livekit-server-sdk');
      const lkUrl = process.env.LIVEKIT_URL;
      try {
        const agentDispatch = new AgentDispatchClient(lkUrl, apiKey, apiSecret);
        await agentDispatch.createDispatch(roomName, 'battlebuddy', {
          metadata: JSON.stringify({
            systemPrompt: voiceSystemPrompt,
            greeting,
            userId: effectiveUserId,
            timezone: timezone || 'America/Chicago',
            last_session_at: agentProfile?.last_session_at || null,
          }),
        });
        console.log(`Dispatched agent to room: ${roomName} (user: ${userName})`);
      } catch (dispatchErr) {
        console.log('Agent dispatch (may already exist):', dispatchErr.message);
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        token,
        url: process.env.LIVEKIT_URL,
        last_session_at: agentProfile?.last_session_at || null,
      }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Push token registration ────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/push/register') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { token, platform, userId } = JSON.parse(body);
      if (!token || !platform || !userId) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing token, platform, or userId' }));
      }

      // Store in Supabase (upsert — ignore duplicates)
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

      if (supabaseUrl && supabaseKey) {
        await fetch(`${supabaseUrl}/rest/v1/push_tokens`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'resolution=ignore-duplicates',
          },
          body: JSON.stringify({ user_id: userId, token, platform }),
        });
      }

      console.log(`Push token registered for user ${userId} (${platform})`);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('Push registration error:', err.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Send nudge (called by cron or manually) ───────────────────────────────
  if (req.method === 'POST' && req.url === '/nudge/send') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const parsed = JSON.parse(body);
      const userId = parsed.userId;
      const nudgeType = parsed.nudgeType || parsed.type || 'check_in';
      const context = parsed.context || { anomalyContext: parsed.anomalyContext };
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

      if (!supabaseUrl || !supabaseKey) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Supabase not configured' }));
      }

      // Fetch user's notification preferences
      const prefsRes = await fetch(
        `${supabaseUrl}/rest/v1/notification_preferences?user_id=eq.${userId}&select=*`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
        },
      );
      const [prefs] = await prefsRes.json();

      // Check if this nudge type is enabled
      const enabledMap = {
        check_in: prefs?.check_in_enabled ?? true,
        streak: prefs?.streak_enabled ?? true,
        re_engage: prefs?.re_engage_enabled ?? true,
      };
      if (!enabledMap[nudgeType]) {
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ skipped: true, reason: 'disabled' }));
      }

      // Check quiet hours
      const timezone = prefs?.timezone || 'America/New_York';
      const quietStart = prefs?.quiet_start || '22:00:00';
      const quietEnd = prefs?.quiet_end || '08:00:00';

      if (isQuietHours(quietStart, quietEnd, timezone)) {
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ skipped: true, reason: 'quiet_hours' }));
      }

      // Get user's push tokens
      const tokensRes = await fetch(
        `${supabaseUrl}/rest/v1/push_tokens?user_id=eq.${userId}&select=token`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
        },
      );
      const tokens = await tokensRes.json();

      if (!tokens.length) {
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ skipped: true, reason: 'no_tokens' }));
      }

      // Build and send the nudge
      const message = pickNudgeMessage(nudgeType, context);
      const results = [];
      for (const { token } of tokens) {
        const result = await sendPush(token, message);
        results.push(result);
      }

      console.log(`Nudge sent to user ${userId}: ${nudgeType}`);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sent: true, count: tokens.length }));
    } catch (err) {
      console.error('Nudge send error:', err.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Offline sync: messages → durable transcript store ─────────────────────
  // The old path wrote to public.messages with a column (urge_event_id) that
  // doesn't exist and a NOT NULL user_id it never sent — every batch failed
  // silently and the client re-sent the growing backlog forever. Transcripts
  // now land next to the voice transcripts on the volume, merged by session.
  if (req.method === 'POST' && req.url === '/sync/messages') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { messages, userId } = JSON.parse(body);
      const syncedIds = [];

      if (messages?.length) {
        const bySession = {};
        for (const m of messages) {
          const sid = m.session_id || 'unknown-session';
          if (!bySession[sid]) bySession[sid] = [];
          bySession[sid].push({
            id: m.id,
            role: m.role,
            content: m.content,
            mode: m.mode,
            timestamp: m.timestamp,
          });
        }
        for (const [sessionId, msgs] of Object.entries(bySession)) {
          appendTranscriptMessages(userId || 'default', sessionId, msgs);
          syncedIds.push(...msgs.map(m => m.id));
        }
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ synced_ids: syncedIds }));
    } catch (err) {
      console.error('Sync messages error:', err.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, synced_ids: [] }));
    }
    return;
  }

  // ─── Offline sync: session events → bb_events ──────────────────────────────
  // craving_events has a uuid FK the app's local text ids can never satisfy
  // (RLS/type mismatch — the table stayed at 0 rows). Sessions now land in
  // bb_events as event_type 'session', deduped by the client-side id so
  // retries are idempotent.
  if (req.method === 'POST' && req.url === '/sync/events') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { events, userId } = JSON.parse(body);
      const syncedIds = [];

      if (supabase && events?.length) {
        const localIds = events.map(e => String(e.id));
        const { data: existing } = await supabase
          .from('bb_events')
          .select('metadata')
          .eq('event_type', 'session')
          .in('metadata->>local_id', localIds);
        const alreadySynced = new Set((existing || []).map(r => r.metadata?.local_id));

        for (const e of events) {
          if (alreadySynced.has(String(e.id))) {
            syncedIds.push(e.id);
            continue;
          }
          // Ghost session guard: opened and abandoned in <10s with no outcome
          // — ack it (so the client stops retrying) but don't store it.
          const durMs = e.ended_at ? new Date(e.ended_at).getTime() - new Date(e.started_at).getTime() : null;
          if (!e.outcome && durMs !== null && durMs >= 0 && durMs < 10000) {
            syncedIds.push(e.id);
            continue;
          }
          let triggerContext = null;
          try { triggerContext = e.trigger_context ? JSON.parse(e.trigger_context) : null; } catch {}

          const { error } = await supabase.from('bb_events').insert({
            user_id: resolveUserId(e.user_id === 'local' ? (userId || 'default') : (e.user_id || userId || 'default')),
            event_type: 'session',
            occurred_at: new Date(e.started_at).toISOString(),
            metadata: {
              source: 'app_session',
              local_id: String(e.id),
              mode: e.mode,
              outcome: e.outcome,
              helped: e.helped != null ? Boolean(e.helped) : null,
              intensity_start: e.intensity_start,
              intensity_end: e.intensity_end,
              ended_at: e.ended_at ? new Date(e.ended_at).toISOString() : null,
              trigger_context: triggerContext,
            },
          });
          if (!error) syncedIds.push(e.id);
          else console.error('Sync events insert error:', error.message);
        }
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ synced_ids: syncedIds }));
    } catch (err) {
      console.error('Sync events error:', err.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, synced_ids: [] }));
    }
    return;
  }

  // ─── Session report generation ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/session/report') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { messages, outcome, triggerContext, cravingEventId, sessionId, userId } = JSON.parse(body);

      if (!messages?.length) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No messages provided' }));
      }

      const transcript = messages
        .map(m => `${m.role === 'user' ? 'User' : 'BattleBuddy'}: ${m.content}`)
        .join('\n');

      const analysisPrompt = `Analyze this BattleBuddy session transcript. Extract everything that would help the next conversation start smarter — not reinventing the wheel.

Return a JSON object with exactly these fields:

{
  "trigger_type": "stress" | "boredom" | "social" | "routine" | "craving" | "unknown",
  "trigger_intensity": 1-5 integer,
  "trigger_texture": "The user's own words for what the urge felt like — physical, emotional, habitual. Quote them.",
  "trigger_context_detail": "Was it social or alone? Post-meal? Driving? Time of day? What was happening around them?",
  "outcome": "${outcome || 'unsure'}",
  "resist_duration_note": "How long did they resist before the session ended? Any indication?",
  "emotional_arc": { "start": "one-word emotion", "end": "one-word emotion" },
  "what_helped": ["Specific things that worked — quote BB's exact phrases that landed, not just categories"],
  "what_didnt_help": ["Things that got ignored, pushed back on, or fell flat"],
  "mode_switches": "Did the user switch between voice and text? Note any pattern.",
  "preferences": {
    "coping_style": "talk-through" | "distraction" | "exercise" | "movement" | "mixed",
    "response_preference": "brief" | "detailed" | "questions",
    "user_metaphors": ["Metaphors or language the user used that felt authentic to them"],
    "user_motivations": ["What drives them — health, family, building something, freedom, etc."],
    "post_slip_behavior": "shame-spiral" | "curious" | "dismissive" | "resilient" | "unknown"
  },
  "same_or_new_trigger": "Was this the same trigger as recent sessions or a new one?",
  "spiral_or_shift": "Is the user spiraling (repeated, escalating) or shifting (trying new approaches, stabilizing)?",
  "key_facts_learned": {
    "name": "User's name if mentioned, null otherwise",
    "preferred_name": "What they want to be called if different from name, null otherwise",
    "age": "User's age if mentioned, null otherwise",
    "location": "Where they live if mentioned, null otherwise",
    "occupation": "Their job/work if mentioned, null otherwise",
    "family": "Family details if mentioned (spouse, kids, etc), null otherwise",
    "cigarettes_per_day": "Number if mentioned, null otherwise",
    "vapes_per_day": "Number if mentioned, null otherwise",
    "urges_per_day": "Number if mentioned, null otherwise",
    "longest_quit": "Duration if mentioned, null otherwise",
    "quit_reason": "Why they want to quit if mentioned, null otherwise",
    "addiction_type": "smoking, vaping, dipping, or other — if mentioned, null otherwise",
    "smoking_history": "How long they've been using nicotine if mentioned, null otherwise",
    "life_events": ["ANY personal facts shared — age, job, family, health, hobbies, stress sources, everything"],
    "health_concerns": "Any health issues mentioned, null otherwise",
    "previous_quit_attempts": "Details of past attempts if mentioned, null otherwise"
  },
  "trackable_metrics": {
    "cigarettes_today": "Number if they said how many they smoked today, null otherwise",
    "urges_today": "Number of urges mentioned, null otherwise",
    "resists_today": "Number of resists mentioned, null otherwise",
    "days_smoke_free": "If they mentioned a streak, null otherwise"
  },
  "next_session_hint": "One concrete sentence: what to try, keep doing, or avoid next time with THIS specific user",
  "summary": "2-3 sentence summary capturing what happened, what was learned about this user, and what changed"
}

Trigger context provided: ${triggerContext ? JSON.stringify(triggerContext) : 'none'}
Outcome reported by user: ${outcome || 'not reported'}

Transcript:
${transcript}

Return ONLY the JSON object, no markdown, no explanation.`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: analysisPrompt }],
      });

      const reportText = response.content[0]?.text || '{}';
      let report;
      try {
        // Use jsonrepair for session reports too
        const { jsonrepair: jr } = await import('jsonrepair');
        try {
          report = JSON.parse(reportText);
        } catch {
          try { report = JSON.parse(jr(reportText)); } catch {
            const jsonMatch = reportText.match(/\{[\s\S]*\}/);
            report = jsonMatch ? JSON.parse(jr(jsonMatch[0])) : {};
          }
        }
      } catch {
        const jsonMatch = reportText.match(/\{[\s\S]*\}/);
        report = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      }

      // Persist the report as a bb_events row. The old session_reports table
      // required a craving_events uuid FK the app can never produce, so every
      // report was generated (a paid Sonnet call) and then discarded.
      const effectiveReportUser = resolveUserId(userId || 'default');
      if (supabase) {
        const { error } = await supabase.from('bb_events').insert({
          user_id: effectiveReportUser,
          event_type: 'session_report',
          occurred_at: new Date().toISOString(),
          metadata: {
            source: 'session_report',
            session_id: sessionId || cravingEventId || null,
            report,
            outcome: report.outcome || outcome || null,
          },
        });
        if (error) console.error('Session report store error:', error.message);
      }

      // Embed the session summary into the memory store
      if (report.summary) {
        embedAndStore(effectiveReportUser, report.summary, 'session_summary', sessionId || cravingEventId).catch(() => {});
      }

      console.log(`Session report generated for session ${sessionId || cravingEventId || 'unknown'} (user ${effectiveReportUser})`);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, report }));
    } catch (err) {
      console.error('Session report error:', err.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Context Agent API ──────────────────────────────────────────────────────

  // List / read raw session transcripts (admin + design-loop tool).
  // GET /context/transcripts/{userId}            → index of sessions
  // GET /context/transcripts/{userId}/{sessionId} → full transcript
  if (req.method === 'GET' && req.url.startsWith('/context/transcripts/')) {
    try {
      const parts = req.url.split('/context/transcripts/')[1].split('/').map(decodeURIComponent);
      const userId = resolveUserId(parts[0] || 'default');
      const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
      const dir = resolve(storeDir, 'session-transcripts', userId);

      if (parts.length > 1 && parts[1]) {
        const safe = parts[1].replace(/[^a-zA-Z0-9._-]/g, '_');
        const data = JSON.parse(readFileSync(resolve(dir, `${safe}.json`), 'utf-8'));
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data));
      }

      let sessions = [];
      try {
        sessions = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
          try {
            const d = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
            return { sessionId: d.sessionId || f.replace('.json', ''), updatedAt: d.updatedAt || null, messageCount: d.messageCount || (d.messages || []).length };
          } catch { return { sessionId: f.replace('.json', ''), updatedAt: null, messageCount: null }; }
        }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      } catch {}
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ userId, sessions }));
    } catch (err) {
      res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Get the context agent's profile for a user
  if (req.method === 'GET' && req.url.startsWith('/context/profile/')) {
    const userId = req.url.split('/context/profile/')[1];
    const summary = buildProfileSummary(userId);
    const profile = loadProfile(userId);
    const lifeArchitecture = buildLifeArchitectureSummary(userId);
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ summary, profile, lifeArchitecture }));
  }

  // Trigger a context analysis (called by the app on session end or mid-session)
  if (req.method === 'POST' && req.url === '/context/analyze') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { userId, sessionId, messages, isSessionEnd, timezone } = JSON.parse(body);

      // Always persist the raw transcript first, independent of extraction —
      // this must survive even if Sonnet analysis below fails.
      try { saveRawTranscript(userId || 'default', sessionId, messages, isSessionEnd, timezone || 'America/Chicago'); }
      catch (e) { console.error('Save raw transcript error:', e.message); }

      // Run async — respond immediately
      analyzeAndUpdate(userId || 'default', messages, isSessionEnd, timezone || 'America/Chicago')
        .then(updates => {
          // Mirror extracted smokes/resists into the transactional event log
          mirrorActivityToEvents(userId || 'default', updates, timezone || 'America/Chicago').catch(() => {});
          // After analysis, embed observations into vector store
          if (updates && isVectorConfigured()) {
            const effectiveUserId = resolveUserId(userId || 'default');
            if (updates.recent_insights) {
              const insights = Array.isArray(updates.recent_insights) ? updates.recent_insights : [updates.recent_insights];
              for (const insight of insights) {
                const val = typeof insight === 'string' ? insight : insight?.value || '';
                if (val) embedAndStore(effectiveUserId, val, 'insight').catch(() => {});
              }
            }
            if (updates.triggers) {
              const triggers = Array.isArray(updates.triggers) ? updates.triggers : [updates.triggers];
              for (const trigger of triggers) {
                const val = typeof trigger === 'string' ? trigger : trigger?.value || '';
                if (val) embedAndStore(effectiveUserId, val, 'trigger').catch(() => {});
              }
            }
          }
        })
        .catch(() => {});
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, queued: true }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Seed a user profile (called on account creation)
  if (req.method === 'POST' && req.url === '/context/seed') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { userId, name } = JSON.parse(body);
      seedProfile(userId || 'default', name);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Record a session outcome (resisted / gave_in) into the user's profile
  if (req.method === 'POST' && req.url === '/context/session-outcome') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { userId, outcome, timestamp } = JSON.parse(body);
      const effectiveUserId = resolveUserId(userId || 'default');
      const profile = loadProfile(effectiveUserId);

      if (!Array.isArray(profile.session_outcomes)) profile.session_outcomes = [];
      profile.session_outcomes.push({
        outcome,
        timestamp: timestamp || new Date().toISOString(),
      });
      // Keep last 100 outcomes
      if (profile.session_outcomes.length > 100) {
        profile.session_outcomes = profile.session_outcomes.slice(-100);
      }

      // Also log as an activity_log entry
      if (!Array.isArray(profile.activity_log)) profile.activity_log = [];
      const tz = 'America/Chicago';
      let localTime, localDate;
      try {
        localTime = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date());
        localDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
      } catch {
        localTime = new Date().toLocaleTimeString();
        localDate = new Date().toISOString().slice(0, 10);
      }
      profile.activity_log.push({
        time: localTime,
        date: localDate,
        event: outcome === 'resisted' ? 'resisted the urge after session' : 'gave in after session',
        type: outcome === 'resisted' ? 'resist' : 'smoke',
        verified: false,
        logged_at: new Date().toISOString(),
      });
      if (profile.activity_log.length > 60) {
        profile.activity_log = profile.activity_log.slice(-60);
      }

      persistProfile(effectiveUserId);

      console.log(`[SessionOutcome] ${effectiveUserId}: ${outcome}`);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Event store (bb_events) ────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/events') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { userId, eventType, occurredAt, metadata } = JSON.parse(body);
      if (!userId || !eventType) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'userId and eventType required' }));
      }
      if (!supabase) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Event store not configured' }));
      }

      const { data, error } = await supabase
        .from('bb_events')
        .insert({
          user_id: resolveUserId(userId),
          event_type: eventType,
          occurred_at: occurredAt || new Date().toISOString(),
          metadata: metadata || {},
        })
        .select('id, occurred_at')
        .single();

      if (error) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: error.message }));
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id: data.id, occurred_at: data.occurred_at }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Content feed — the curated video library for the Support Scroll ───────
  // Served through the server because content_videos has RLS enabled with no
  // anon-read policy: the app's direct Supabase query silently returned [] and
  // the feed showed its empty state forever.
  if (req.method === 'GET' && req.url.startsWith('/content/feed')) {
    if (!supabase) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Content store not configured' }));
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 20, 50);
      const offset = parseInt(url.searchParams.get('offset'), 10) || 0;

      const { data, error } = await supabase
        .from('content_videos')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw new Error(error.message);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ videos: data || [] }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Correct/delete an event — used by the voice agent's update_event tool
  if (req.method === 'POST' && req.url === '/events/update') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { userId, eventId, action, eventType, occurredAt, notes } = JSON.parse(body);
      const result = await updateEvent(resolveUserId(userId || 'default'), {
        event_id: eventId, action, event_type: eventType, occurred_at: occurredAt, notes,
      });
      res.writeHead(result.error ? 500 : 200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'GET' && req.url.startsWith('/events')) {
    const url = new URL(req.url, 'http://localhost');
    const userId = url.searchParams.get('userId');
    const date = url.searchParams.get('date');
    const eventTypesParam = url.searchParams.get('eventTypes');
    const limit = url.searchParams.get('limit') || '50';

    if (!userId) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'userId required' }));
    }

    try {
      const eventTypes = eventTypesParam ? eventTypesParam.split(',') : undefined;
      const timezone = url.searchParams.get('timezone') || DEFAULT_TZ;
      const events = await queryEvents(resolveUserId(userId), { date, eventTypes, limit, timezone });
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ events, count: events.length }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // One-shot hygiene sweep: deletes ghost transcript files (sessions that
  // captured <2 real messages — failed initializations) and ghost session
  // rows in bb_events (opened and abandoned within 10s, no outcome). The
  // nightly audit flagged 80+ of these polluting the record.
  if (req.method === 'POST' && req.url === '/admin/cleanup') {
    try {
      const result = { transcripts_deleted: 0, ghost_sessions_deleted: 0 };
      const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
      const transcriptsRoot = resolve(storeDir, 'session-transcripts');

      let userDirs = [];
      try { userDirs = readdirSync(transcriptsRoot); } catch {}
      for (const userId of userDirs) {
        const dir = resolve(transcriptsRoot, userId);
        let files = [];
        try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
        for (const f of files) {
          try {
            const d = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
            const real = (d.messages || []).filter(m => (m.content || '').trim().length > 0);
            if (real.length < 2) {
              unlinkSync(resolve(dir, f));
              result.transcripts_deleted++;
            }
          } catch {}
        }
      }

      if (supabase) {
        const { data } = await supabase
          .from('bb_events')
          .select('id, occurred_at, metadata')
          .eq('event_type', 'session')
          .limit(1000);
        const ghosts = (data || []).filter(r => {
          const m = r.metadata || {};
          if (m.outcome) return false;
          if (!m.ended_at) return false;
          const dur = new Date(m.ended_at).getTime() - new Date(r.occurred_at).getTime();
          return dur >= 0 && dur < 10000;
        }).map(r => r.id);
        if (ghosts.length) {
          const { error } = await supabase.from('bb_events').delete().in('id', ghosts);
          if (!error) result.ghost_sessions_deleted = ghosts.length;
        }
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Trigger a transcript audit on demand
  if (req.method === 'POST' && req.url === '/admin/audit/run') {
    try {
      const result = await runTranscriptAudit(true);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Admin panel ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/admin') {
    const html = readFileSync(resolve(__dirname, 'admin.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (req.method === 'GET' && req.url === '/admin/voice') {
    try {
      const config = JSON.parse(readFileSync(resolve(__dirname, 'voice-config.json'), 'utf-8'));
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(config));
    } catch {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ voice: 'aura-2-arcas-en' }));
    }
  }

  if (req.method === 'POST' && req.url === '/admin/voice') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { voice } = JSON.parse(body);
      writeFileSync(resolve(__dirname, 'voice-config.json'), JSON.stringify({ voice }));
      console.log(`Voice changed to: ${voice}`);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, voice }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Profile upload endpoint (admin tool) ──────────────────────────────────
  if (req.method === 'PUT' && req.url.startsWith('/context/profile/')) {
    const userId = req.url.split('/context/profile/')[1];
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const profile = JSON.parse(body);
      // Full replacement of both the file and the in-memory cache — the old
      // Object.assign merge left deleted fields alive in memory until restart.
      replaceProfile(userId, profile);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, name: profile.name, session_count: profile.session_count }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Profile merge endpoint (one-time admin tool) ─────────────────────────
  if (req.method === 'POST' && req.url === '/context/merge') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { sourceId, targetId } = JSON.parse(body);
      const merged = mergeProfiles(sourceId, targetId);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, session_count: merged.session_count }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── Risk windows endpoint ──────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/risk-windows/')) {
    const userId = req.url.split('/risk-windows/')[1];
    try {
      const profile = loadProfile(userId);
      const windows = (profile.risk_windows || []).map(rw => ({
        hour: rw.hour,
        day_of_week: rw.day_of_week,
        weight: rw.weight,
        source: rw.source,
      }));
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ windows }));
    } catch (err) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── LiveKit Webhook — safety net for transcript capture ───────────────────
  if (req.method === 'POST' && req.url === '/livekit/webhook') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { WebhookReceiver } = await import('livekit-server-sdk');
      const receiver = new WebhookReceiver(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
      );
      const event = await receiver.receive(body, req.headers.authorization);

      if (event.event === 'room_finished' && event.room) {
        const roomName = event.room.name;
        const metadata = event.room.metadata || '{}';
        let userId = 'default';
        try {
          const meta = JSON.parse(metadata);
          userId = meta.userId || 'default';
        } catch {}

        // Extract userId from room name as fallback (format: bb-{userId})
        if (userId === 'default' && roomName.startsWith('bb-')) {
          userId = roomName.replace('bb-', '');
        }

        // Observability only. This webhook used to increment session_count as
        // a "safety net", but the voice agent's final transcript (3 retries)
        // already increments it via analyzeAndUpdate — the net effect was
        // double-counting every voice session.
        console.log(`[Webhook] Room finished: ${roomName} (user: ${userId})`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log(`[Webhook] Error: ${e.message}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, vector_store: isVectorConfigured() }));
  }

  res.writeHead(404, CORS);
  res.end('Not found');
});

// ─── Nightly transcript audit ─────────────────────────────────────────────────
// Reads the last day's raw conversation transcripts and has Sonnet audit them
// for agent-behavior wins/failures (with verbatim quotes) and app/product
// issues the user mentioned. Report-only: results land in bb_events as
// 'transcript_audit' rows (GET /events?eventTypes=transcript_audit) for review —
// nothing is auto-applied to the prompt. Runs once per local day after 3 AM;
// POST /admin/audit/run triggers it on demand.

const AUDIT_HOUR = 3;

async function runTranscriptAudit(force = false) {
  if (!supabase) return { error: 'event store not configured' };
  const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
  const transcriptsRoot = resolve(storeDir, 'session-transcripts');

  let userDirs = [];
  try { userDirs = readdirSync(transcriptsRoot); } catch { return { error: 'no transcripts' }; }

  const results = [];
  for (const userId of userDirs) {
    try {
      const dir = resolve(transcriptsRoot, userId);
      const cutoff = Date.now() - 26 * 3600 * 1000;
      const sessions = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
        try { return JSON.parse(readFileSync(resolve(dir, f), 'utf-8')); } catch { return null; }
      })
        .filter(s => s && s.updatedAt && new Date(s.updatedAt).getTime() > cutoff && (s.messages || []).length >= 4)
        // A bulk offline sync can touch every historical file at once (103
        // sessions matched the window on night one) — audit only the most
        // recent handful; older material was already covered by prior runs.
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, 12);

      if (!sessions.length) continue;

      let corpus = '';
      for (const s of sessions.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''))) {
        corpus += `\n\n=== SESSION ${s.sessionId} (${s.updatedAt}) ===\n`;
        for (const m of s.messages) {
          const line = `${m.role === 'user' ? 'USER' : 'BB'}: ${m.content}\n`;
          if (corpus.length + line.length > 90000) break;
          corpus += line;
        }
      }

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are auditing raw conversation transcripts between a user and BattleBuddy (BB), a smoking-cessation companion agent. Produce a concise, evidence-based audit for the developer.

Return JSON only:
{
  "agent_wins": ["specific BB behavior that landed well — include a short verbatim quote as evidence"],
  "agent_failures": ["specific BB behavior that failed or eroded trust — verbatim quote + why it failed"],
  "app_issues": ["bugs, UX problems, or missing capabilities the USER mentioned or that are evident (e.g. data loss, latency complaints, feature requests) — verbatim quote"],
  "proposals": ["concrete, targeted change proposals for the agent prompt or app, each traceable to evidence above; rate each HIGH/MEDIUM/LOW confidence"],
  "user_state": "one-paragraph read of where this user is in their quit journey based on these sessions",
  "summary": "2-3 sentences: the single most important thing the developer should act on"
}

Transcripts:${corpus}`,
        }],
      });

      const text = response.content[0]?.text || '{}';
      let report;
      try {
        const { jsonrepair: jr } = await import('jsonrepair');
        try { report = JSON.parse(text); } catch {
          const m = text.match(/\{[\s\S]*\}/);
          report = JSON.parse(jr(m ? m[0] : text));
        }
      } catch { report = { raw: text.slice(0, 4000) }; }

      await supabase.from('bb_events').insert({
        user_id: userId,
        event_type: 'transcript_audit',
        occurred_at: new Date().toISOString(),
        metadata: {
          source: 'nightly_audit',
          sessions_audited: sessions.map(s => s.sessionId),
          report,
        },
      });
      results.push({ userId, sessions: sessions.length, summary: report.summary || null });
      console.log(`[Audit] ${userId}: ${sessions.length} session(s) audited — ${report.summary || 'no summary'}`);
    } catch (e) {
      console.log(`[Audit] Error for ${userId}: ${e.message}`);
    }
  }
  return { ok: true, audited: results };
}

const auditStatePath = () => resolve(process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store'), 'audit-state.json');

setInterval(() => {
  try {
    const today = localDateInTz(DEFAULT_TZ);
    const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, hour: 'numeric', hour12: false }).format(new Date()), 10);
    let state = {};
    try { state = JSON.parse(readFileSync(auditStatePath(), 'utf-8')); } catch {}
    if (hour >= AUDIT_HOUR && state.last_run_date !== today) {
      writeFileSync(auditStatePath(), JSON.stringify({ last_run_date: today }));
      runTranscriptAudit().catch(e => console.log(`[Audit] Sweep failed: ${e.message}`));
    }
  } catch {}
}, 30 * 60 * 1000);

// ─── Proactive nudge scheduler ────────────────────────────────────────────────
// The piece that was always missing: risk windows were learned into profiles
// but nothing ever acted on them. Every 15 minutes, check each user's learned
// risk windows against their local clock and send a history-aware nudge —
// conservatively: quiet hours respected, ≥90 min between nudges, max 3/day.

const NUDGE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const NUDGE_MIN_GAP_MS = 90 * 60 * 1000;
const NUDGE_MAX_PER_DAY = 3;
const NUDGE_MIN_WEIGHT = 0.6;

async function runNudgeSweep() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
  let files = [];
  try {
    files = readdirSync(storeDir).filter(f => f.endsWith('.json') && !f.startsWith('default'));
  } catch { return; }

  for (const file of files) {
    const userId = file.replace('.json', '');
    try {
      const profile = loadProfile(userId);
      const timezone = profile.timezone || DEFAULT_TZ;
      const windows = profile.risk_windows || [];
      if (!windows.length) continue;

      // Quiet hours (default 22:00–08:00 local)
      if (isQuietHours('22:00', '08:00', timezone)) continue;

      // Rate limits
      const now = Date.now();
      const lastNudgeAt = profile.last_nudge_at ? new Date(profile.last_nudge_at).getTime() : 0;
      if (now - lastNudgeAt < NUDGE_MIN_GAP_MS) continue;
      const today = localDateInTz(timezone);
      const sentToday = (profile.nudge_log || []).filter(n => n.date === today).length;
      if (sentToday >= NUDGE_MAX_PER_DAY) continue;

      // Don't nudge someone who just talked to BB
      if (profile.last_session_at && now - new Date(profile.last_session_at).getTime() < 60 * 60 * 1000) continue;

      // Is this hour a learned risk window?
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: 'numeric', hour12: false, weekday: 'short',
      }).formatToParts(new Date());
      const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '-1', 10);
      const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        .indexOf(parts.find(p => p.type === 'weekday')?.value || '');
      const match = windows.find(rw =>
        rw.hour === hour &&
        (rw.day_of_week === null || rw.day_of_week === undefined || rw.day_of_week === dayIdx) &&
        (rw.weight || 0) >= NUDGE_MIN_WEIGHT,
      );
      if (!match) continue;

      // Fetch push tokens
      const tokensRes = await fetch(
        `${supabaseUrl}/rest/v1/push_tokens?user_id=eq.${encodeURIComponent(userId)}&select=token`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
      );
      const tokens = tokensRes.ok ? await tokensRes.json() : [];
      if (!Array.isArray(tokens) || tokens.length === 0) continue;

      const message = pickNudgeMessage('check_in', {
        anomalyContext: { trigger_type: 'risk_window' },
        riskMessage: match.source
          ? `This is usually a tough window for you (${match.source}). What's happening right now?`
          : undefined,
      });
      for (const { token } of tokens) {
        await sendPush(token, message);
      }

      profile.last_nudge_at = new Date().toISOString();
      if (!Array.isArray(profile.nudge_log)) profile.nudge_log = [];
      profile.nudge_log.push({ date: today, hour, sent_at: profile.last_nudge_at, source: match.source || 'risk_window' });
      if (profile.nudge_log.length > 30) profile.nudge_log = profile.nudge_log.slice(-30);
      persistProfile(userId);

      console.log(`[Nudge] Risk-window nudge sent to ${userId} (hour ${hour}, weight ${match.weight})`);
    } catch (e) {
      console.log(`[Nudge] Error for ${userId}: ${e.message}`);
    }
  }
}

setInterval(() => { runNudgeSweep().catch(() => {}); }, NUDGE_CHECK_INTERVAL_MS);

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`BattleBuddy API running on http://0.0.0.0:${PORT}`);
  console.log(`Vector store: ${isVectorConfigured() ? 'configured' : 'not configured (set SUPABASE_URL + SUPABASE_SERVICE_KEY)'}`);
});
