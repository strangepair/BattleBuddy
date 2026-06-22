import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { AccessToken } from 'livekit-server-sdk';
import { sendPush, isQuietHours, pickNudgeMessage } from './notifications.js';

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

// Load the system prompt
const systemPromptPath = resolve(__dirname, '..', 'prompts', 'system.battlebuddy.md');
const systemPromptTemplate = readFileSync(systemPromptPath, 'utf-8');

// Path to the CSM venv's Python (for whisper transcription)
const WHISPER_PYTHON = resolve(__dirname, '..', 'sesame-csm', '.venv', 'bin', 'python3');

function buildSystemPrompt(profile, triggerContext, recentHistory) {
  return systemPromptTemplate
    .replace('{{profile}}', profile || 'New user — no history yet.')
    .replace('{{trigger_context}}', triggerContext || 'Not provided.')
    .replace('{{recent_history}}', recentHistory || 'First message in this session.');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

  if (req.method === 'POST' && req.url === '/session/turn') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { messages, profile, trigger_context } = JSON.parse(body);
      const systemPrompt = buildSystemPrompt(
        profile,
        trigger_context ? JSON.stringify(trigger_context) : undefined,
        messages?.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n'),
      );

      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const stream = client.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('Error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err.message }));
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
      const { room, identity } = JSON.parse(body);
      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;

      if (!apiKey || !apiSecret) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'LiveKit not configured' }));
      }

      const roomName = room || 'battlebuddy';
      const at = new AccessToken(apiKey, apiSecret, { identity: identity || `user-${Date.now()}` });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();

      // Dispatch the agent to the room
      const { RoomServiceClient, AgentDispatchClient } = await import('livekit-server-sdk');
      const lkUrl = process.env.LIVEKIT_URL;
      try {
        const agentDispatch = new AgentDispatchClient(lkUrl, apiKey, apiSecret);
        await agentDispatch.createDispatch(roomName, 'battlebuddy');
        console.log(`Dispatched agent to room: ${roomName}`);
      } catch (dispatchErr) {
        console.log('Agent dispatch (may already exist):', dispatchErr.message);
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, url: process.env.LIVEKIT_URL }));
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
      const { userId, nudgeType, context } = JSON.parse(body);
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

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404, CORS);
  res.end('Not found');
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`BattleBuddy API running on http://0.0.0.0:${PORT}`);
});
