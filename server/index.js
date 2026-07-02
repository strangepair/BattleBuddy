process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { AccessToken } from 'livekit-server-sdk';
import { sendPush, isQuietHours, pickNudgeMessage } from './notifications.js';
import { analyzeAndUpdate, buildProfileSummary, buildLifeArchitectureSummary, buildCurrentGoal, computeUsageStats, lookupProfileField, loadProfile, seedProfile, mergeProfiles, resolveUserId, saveRawTranscript } from './contextAgent.js';
import { embedAndStore, retrieveRelevant, isConfigured as isVectorConfigured } from './vectorStore.js';

const execFileAsync = promisify(execFile);
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

// Path to the system prompt (read fresh on every call so agentDesignLoop
// updates go live without a redeploy)
const systemPromptPath = resolve(__dirname, 'prompts', 'system.battlebuddy.md');

// Path to the CSM venv's Python (for whisper transcription)
const WHISPER_PYTHON = resolve(__dirname, '..', 'sesame-csm', '.venv', 'bin', 'python3');

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

function buildSystemPrompt(profile, triggerContext, recentHistory, timezone, lifeArchitecture, sessionContext, currentGoal) {
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
    .replace('{{session_context}}', sessionContext || 'No prior session data.');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// Parse multipart form data (minimal, for audio upload)
function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1];
  const boundaryBuffer = Buffer.from(`--${boundary}`);

  let start = buffer.indexOf(boundaryBuffer) + boundaryBuffer.length;
  const end = buffer.indexOf(Buffer.from(`--${boundary}--`));
  const part = buffer.subarray(start, end);

  const headerEnd = part.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;

  return part.subarray(headerEnd + 4).subarray(0, -2); // trim trailing \r\n
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // ─── Usage stats tool endpoint (Bug B) ──────────────────────────────────────
  if (req.method === 'GET' && req.url.match(/^\/context\/stats\//)) {
    const parts = req.url.split('/context/stats/');
    const userId = decodeURIComponent(parts[1] || '');
    try {
      const stats = computeUsageStats(userId);
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

      // Use the context agent's profile if available, fall back to client-provided
      const effectiveUserId = userId || 'default';
      const contextProfile = buildProfileSummary(effectiveUserId);
      const finalProfile = (contextProfile && !contextProfile.includes('New user'))
        ? contextProfile
        : profile;

      const lifeArchitecture = buildLifeArchitectureSummary(effectiveUserId);
      const currentGoal = buildCurrentGoal(effectiveUserId);
      const agentProfile = loadProfile(effectiveUserId);
      const sessionContext = buildSessionContext(agentProfile);

      const systemPrompt = buildSystemPrompt(
        finalProfile,
        trigger_context ? JSON.stringify(trigger_context) : undefined,
        recent_history || messages?.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n'),
        timezone,
        lifeArchitecture,
        sessionContext,
        currentGoal,
      );

      // Fire background analysis (non-blocking) — Sonnet extracts facts while Haiku responds
      if (messages?.length >= 2) {
        analyzeAndUpdate(effectiveUserId, messages, false, timezone).catch(() => {});
      }

      const stream = client.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      });

      // Wait for the first event before committing to SSE —
      // this lets pre-stream errors (billing, auth) return a proper HTTP status
      let headersSent = false;
      for await (const event of stream) {
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

      res.write('data: [DONE]\n\n');
      res.end();
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

  if (req.method === 'POST' && req.url === '/transcribe') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    try {
      const contentType = req.headers['content-type'] || '';
      const audioData = parseMultipart(buffer, contentType);

      if (!audioData || audioData.length < 100) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No audio data received' }));
      }

      // Write audio to temp file
      const tmpDir = mkdtempSync(join(tmpdir(), 'bb-'));
      const audioPath = join(tmpDir, 'recording.m4a');
      writeFileSync(audioPath, audioData);

      // Transcribe with mlx-whisper via the CSM venv
      const script = `
import mlx_whisper
result = mlx_whisper.transcribe("${audioPath}", path_or_hf_repo="mlx-community/whisper-tiny")
print(result["text"].strip())
`;
      const { stdout } = await execFileAsync(WHISPER_PYTHON, ['-c', script], {
        timeout: 30000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });

      // Cleanup
      try { unlinkSync(audioPath); } catch {}

      const text = stdout.trim();
      console.log('Transcribed:', text);

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      console.error('Transcription error:', err.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Transcription failed', details: err.message }));
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

      // Use context agent's profile if available
      const effectiveUserId = identity || 'default';
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

  // ─── Offline sync: messages ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/sync/messages') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { messages } = JSON.parse(body);
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
      const syncedIds = [];

      if (supabaseUrl && supabaseKey && messages?.length) {
        const rows = messages.map(m => ({
          id: m.id,
          urge_event_id: m.session_id,
          role: m.role,
          content: m.content,
          modality: m.mode === 'voice' ? 'voice' : 'text',
          created_at: new Date(m.timestamp).toISOString(),
        }));

        const upsertRes = await fetch(`${supabaseUrl}/rest/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify(rows),
        });

        if (upsertRes.ok) {
          syncedIds.push(...messages.map(m => m.id));
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

  // ─── Offline sync: craving events ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/sync/events') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { events } = JSON.parse(body);
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
      const syncedIds = [];

      if (supabaseUrl && supabaseKey && events?.length) {
        const rows = events.map(e => ({
          id: e.id,
          user_id: e.user_id,
          started_at: new Date(e.started_at).toISOString(),
          ended_at: e.ended_at ? new Date(e.ended_at).toISOString() : null,
          mode: e.mode,
          outcome: e.outcome,
          helped: e.helped != null ? Boolean(e.helped) : null,
          intensity_start: e.intensity_start,
          intensity_end: e.intensity_end,
          trigger_context: e.trigger_context ? JSON.parse(e.trigger_context) : null,
        }));

        const upsertRes = await fetch(`${supabaseUrl}/rest/v1/urge_events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify(rows),
        });

        if (upsertRes.ok) {
          syncedIds.push(...events.map(e => e.id));
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
      const { messages, outcome, triggerContext, cravingEventId, userId } = JSON.parse(body);

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

      // Store in Supabase if configured
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

      if (supabaseUrl && supabaseKey && cravingEventId && userId) {
        await fetch(`${supabaseUrl}/rest/v1/session_reports`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'resolution=ignore-duplicates',
          },
          body: JSON.stringify({
            craving_event_id: cravingEventId,
            user_id: userId,
            trigger_type: report.trigger_type || null,
            trigger_intensity: report.trigger_intensity || null,
            outcome: report.outcome || outcome || null,
            emotional_arc: report.emotional_arc || {},
            what_helped: report.what_helped || [],
            what_didnt_help: report.what_didnt_help || [],
            preferences: {
              ...(report.preferences || {}),
              trigger_texture: report.trigger_texture || null,
              trigger_context_detail: report.trigger_context_detail || null,
              resist_duration_note: report.resist_duration_note || null,
              mode_switches: report.mode_switches || null,
              same_or_new_trigger: report.same_or_new_trigger || null,
              spiral_or_shift: report.spiral_or_shift || null,
              key_facts_learned: report.key_facts_learned || null,
              trackable_metrics: report.trackable_metrics || null,
            },
            next_session_hint: report.next_session_hint || null,
            summary: report.summary || 'Session completed.',
          }),
        });

        // Embed the session summary into vector store
        if (report.summary) {
          embedAndStore(userId, report.summary, 'session_summary', cravingEventId).catch(() => {});
        }
      }

      console.log(`Session report generated for event ${cravingEventId}`);
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

      profile.last_updated = new Date().toISOString();
      const storePath = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
      try { mkdirSync(storePath, { recursive: true }); } catch {}
      writeFileSync(resolve(storePath, `${effectiveUserId}.json`), JSON.stringify(profile, null, 2));

      console.log(`[SessionOutcome] ${effectiveUserId}: ${outcome}`);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
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
      const storePath = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
      try { mkdirSync(storePath, { recursive: true }); } catch {}
      writeFileSync(resolve(storePath, `${userId}.json`), JSON.stringify(profile, null, 2));
      // Clear the in-memory cache so loadProfile picks up the new file
      const p = loadProfile(userId);
      Object.assign(p, profile);
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

        console.log(`[Webhook] Room finished: ${roomName} (user: ${userId})`);

        const profile = loadProfile(userId);
        if (profile && profile.last_updated) {
          const lastUpdate = new Date(profile.last_updated).getTime();
          const now = Date.now();
          if (now - lastUpdate < 5 * 60 * 1000) {
            profile.session_count = (profile.session_count || 0) + 1;
            profile.last_session_at = new Date().toISOString();
            profile.last_updated = new Date().toISOString();
            const storePath = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
            try { mkdirSync(storePath, { recursive: true }); } catch {}
            writeFileSync(resolve(storePath, `${userId}.json`), JSON.stringify(profile, null, 2));
            console.log(`[Webhook] Session count incremented for ${userId}: ${profile.session_count}`);
          }
        }
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

// ─── Transcript watcher — picks up files written by the voice agent ──────────
const TRANSCRIPT_DIR = resolve(__dirname, 'transcripts');
try { mkdirSync(TRANSCRIPT_DIR, { recursive: true }); } catch {}

setInterval(async () => {
  try {
    const files = readdirSync(TRANSCRIPT_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = resolve(TRANSCRIPT_DIR, file);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (data.messages && data.messages.length >= 2) {
          console.log(`[TranscriptWatcher] Processing ${file} (${data.messages.length} messages for ${data.userId})`);
          await analyzeAndUpdate(data.userId || 'default', data.messages, data.isSessionEnd || false);
          console.log(`[TranscriptWatcher] Profile updated for ${data.userId}`);
        }
        unlinkSync(filePath);
      } catch (e) {
        console.log(`[TranscriptWatcher] Error processing ${file}: ${e.message}`);
        try { unlinkSync(filePath); } catch {}
      }
    }
  } catch {}
}, 5000); // Check every 5 seconds

// ─── Nightly risk window sync to Supabase ─────────────────────────────────────
async function syncRiskWindowsToSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
  try {
    const files = readdirSync(storeDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const profile = JSON.parse(readFileSync(resolve(storeDir, file), 'utf-8'));
        const userId = file.replace('.json', '');
        const windows = profile.risk_windows || [];
        if (!windows.length) continue;

        for (const rw of windows) {
          await fetch(`${supabaseUrl}/rest/v1/risk_windows`, {
            method: 'POST',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates',
            },
            body: JSON.stringify({
              user_id: userId,
              day_of_week: rw.day_of_week,
              hour: rw.hour,
              weight: rw.weight || 0.5,
            }),
          });
        }
        console.log(`[RiskSync] Synced ${windows.length} windows for ${userId}`);
      } catch (e) {
        console.log(`[RiskSync] Error for ${file}: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`[RiskSync] Failed: ${e.message}`);
  }
}

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`BattleBuddy API running on http://0.0.0.0:${PORT}`);
  console.log(`Vector store: ${isVectorConfigured() ? 'configured' : 'not configured (set SUPABASE_URL + SUPABASE_SERVICE_KEY)'}`);
});
