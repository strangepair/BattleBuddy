/**
 * Admin console API — lets the founder tune the agent's behavior from a web UI
 * (served at GET /admin/console) without a coding session:
 *
 *   - System prompt: view/edit server/prompts/system.battlebuddy.md. Writes go
 *     live on the next turn (the prompt is read fresh per request) AND are
 *     persisted to the volume, restored on boot so they survive redeploys.
 *     If a deploy ships a *different* prompt than the one the console edit was
 *     based on (e.g. a design-loop commit), the repo version wins and the
 *     console edit is archived on the volume — see restoreConsoleEditOnBoot.
 *     (Committing from here is impossible: the production image has no git,
 *     no .git dir, and no credentials — build context is server/ only.)
 *   - Resources: reference documents (research, frameworks) stored on the
 *     Railway volume and injected into every prompt (see buildAdminInjections
 *     in contextAgent.js).
 *   - Directives: short behavioral instructions with optional expiry dates,
 *     injected above the persona so they override conflicting guidance.
 *   - Insights: transcript-audit reports (wins/failures/proposals with
 *     verbatim evidence) read from bb_events, plus an on-demand analysis run.
 *
 * All data routes require the x-bb-admin-secret header (checkAdminSecret is
 * passed in from index.js). Only the HTML shell is open — same rationale as
 * GET /admin: a browser navigation can't attach custom headers.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  ADMIN_DATA_ROOT, RESOURCES_DIR, DIRECTIVES_PATH, loadDirectives, isDirectiveActive,
  SYSTEM_PROMPT_PATH, persistPromptLive, promptDivergedFromRepo,
} from './contextAgent.js';
import { runDesignLoop, AGENT_MD_VOLUME_PATH, readAgentMd } from './agentDesignLoop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const consoleHtmlPath = resolve(__dirname, 'admin-console.html');

// Every one of these must survive a prompt edit — buildSystemPrompt fills them
// per turn, and .replace() silently no-ops on a missing placeholder, so losing
// {{profile}} would quietly erase the agent's memory of the user.
const REQUIRED_PLACEHOLDERS = [
  '{{current_goal}}', '{{profile}}', '{{trigger_context}}', '{{recent_history}}',
  '{{life_architecture}}', '{{session_context}}', '{{relevant_memories}}',
];

const MAX_DIRECTIVE_CHARS = 500;
const MAX_RESOURCE_CHARS = 200000;

function json(res, CORS, status, payload) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/** Map a client-supplied resource name to a safe path inside RESOURCES_DIR.
 * Returns null if the name is empty after sanitizing or escapes the dir. */
function resourcePath(rawName) {
  const cleaned = basename(String(rawName || '')).replace(/[^a-zA-Z0-9 ()&+',._-]/g, '').trim();
  if (!cleaned || cleaned.startsWith('.')) return null;
  const withExt = /\.[a-zA-Z0-9]+$/.test(cleaned) ? cleaned : `${cleaned}.md`;
  const path = resolve(RESOURCES_DIR, withExt);
  if (!path.startsWith(RESOURCES_DIR + sep)) return null;
  return { path, name: withExt };
}

function saveDirectives(list) {
  mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
  writeFileSync(DIRECTIVES_PATH, JSON.stringify(list, null, 2));
}

/** Shared by POST /directives and POST /insights/apply. Throws with .status
 * on validation failure. */
function addDirective(text, expires) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw Object.assign(new Error('Directive text is empty.'), { status: 400 });
  if (trimmed.length > MAX_DIRECTIVE_CHARS) {
    throw Object.assign(new Error(`Directives are short instructions — max ${MAX_DIRECTIVE_CHARS} chars. Longer material belongs in Resources.`), { status: 400 });
  }
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    throw Object.assign(new Error('Expiry must be YYYY-MM-DD.'), { status: 400 });
  }
  const directive = {
    id: `d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: trimmed,
    expires: expires || null,
    createdAt: new Date().toISOString(),
  };
  saveDirectives([...loadDirectives(), directive]);
  return directive;
}

// ─── Insights apply-state ─────────────────────────────────────────────────────
// Recommendations Mike has turned into directives disappear from the Insights
// list. Keyed by report id + a hash of the ORIGINAL proposal text (he may edit
// the directive wording), stored on the volume.
const INSIGHTS_STATE_PATH = resolve(ADMIN_DATA_ROOT, 'insights-state.json');
const sha256 = s => createHash('sha256').update(s).digest('hex');
const proposalKey = (reportId, proposalText) => `${reportId}#${sha256(String(proposalText)).slice(0, 16)}`;

function loadInsightsState() {
  try { return JSON.parse(readFileSync(INSIGHTS_STATE_PATH, 'utf-8')); } catch { return { applied: {} }; }
}
function saveInsightsState(state) {
  mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
  writeFileSync(INSIGHTS_STATE_PATH, JSON.stringify(state, null, 2));
}

export async function handleAdminConsole(req, res, { checkAdminSecret, CORS, send401, runTranscriptAudit, fetchAuditReports }) {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
    return res.end();
  }

  // HTML shell — open (carries no data; scripts inside prompt for the secret).
  if (req.method === 'GET' && url === '/admin/console') {
    const html = readFileSync(consoleHtmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (!checkAdminSecret(req)) return send401(res, 401, 'Unauthorized');

  try {
    // ─── System prompt ────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/admin/console/prompt') {
      const content = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
      return json(res, CORS, 200, {
        content,
        chars: content.length,
        divergedFromRepo: promptDivergedFromRepo(content),
      });
    }

    if (req.method === 'POST' && url === '/admin/console/prompt') {
      const { content, force } = JSON.parse(await readBody(req));
      if (typeof content !== 'string' || content.trim().length < 200) {
        return json(res, CORS, 400, { error: 'Prompt content missing or suspiciously short — refusing to save.' });
      }
      const missing = REQUIRED_PLACEHOLDERS.filter(p => !content.includes(p));
      if (missing.length > 0 && !force) {
        return json(res, CORS, 400, {
          error: `Missing required placeholders: ${missing.join(', ')}. These are filled per turn — removing them silently breaks context injection. Re-send with force: true to save anyway.`,
          missing,
        });
      }
      persistPromptLive(content);
      console.log(`[AdminConsole] System prompt saved (${content.length} chars) — live on next turn, persisted to volume`);
      return json(res, CORS, 200, {
        ok: true,
        chars: content.length,
        divergedFromRepo: promptDivergedFromRepo(content),
      });
    }

    // ─── Resources ────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/admin/console/resources') {
      let resources = [];
      try {
        resources = readdirSync(RESOURCES_DIR)
          .filter(f => !f.startsWith('.'))
          .sort()
          .map(name => {
            const st = statSync(resolve(RESOURCES_DIR, name));
            return { name, size: st.size, modifiedAt: st.mtime.toISOString() };
          });
      } catch {} // dir doesn't exist yet
      return json(res, CORS, 200, { resources });
    }

    if (req.method === 'POST' && url === '/admin/console/resources') {
      const { name, content } = JSON.parse(await readBody(req));
      const target = resourcePath(name);
      if (!target) return json(res, CORS, 400, { error: 'Invalid resource name.' });
      if (typeof content !== 'string' || !content.trim()) {
        return json(res, CORS, 400, { error: 'Resource content is empty.' });
      }
      if (content.length > MAX_RESOURCE_CHARS) {
        return json(res, CORS, 400, { error: `Resource too large (${content.length} chars, max ${MAX_RESOURCE_CHARS}).` });
      }
      mkdirSync(RESOURCES_DIR, { recursive: true });
      const existed = existsSync(target.path);
      writeFileSync(target.path, content);
      console.log(`[AdminConsole] Resource ${existed ? 'updated' : 'added'}: ${target.name} (${content.length} chars)`);
      return json(res, CORS, 200, { ok: true, name: target.name, updated: existed });
    }

    const resourceMatch = url.match(/^\/admin\/console\/resources\/(.+)$/);
    if (resourceMatch) {
      const target = resourcePath(decodeURIComponent(resourceMatch[1]));
      if (!target || !existsSync(target.path)) return json(res, CORS, 404, { error: 'Resource not found.' });
      if (req.method === 'GET') {
        return json(res, CORS, 200, { name: target.name, content: readFileSync(target.path, 'utf-8') });
      }
      if (req.method === 'DELETE') {
        unlinkSync(target.path);
        console.log(`[AdminConsole] Resource deleted: ${target.name}`);
        return json(res, CORS, 200, { ok: true });
      }
    }

    // ─── Directives ───────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/admin/console/directives') {
      const directives = loadDirectives().map(d => ({ ...d, active: isDirectiveActive(d) }));
      return json(res, CORS, 200, { directives });
    }

    if (req.method === 'POST' && url === '/admin/console/directives') {
      const { text, expires } = JSON.parse(await readBody(req));
      const directive = addDirective(text, expires);
      console.log(`[AdminConsole] Directive added: "${directive.text.slice(0, 60)}"${expires ? ` (expires ${expires})` : ''}`);
      return json(res, CORS, 200, { ok: true, directive: { ...directive, active: isDirectiveActive(directive) } });
    }

    // ─── Insights (transcript-audit recommendations) ──────────────────────
    // Reuses the existing audit engine (runTranscriptAudit in index.js) —
    // one analysis pipeline, surfaced here so Mike can read the reports and
    // trigger a fresh pass without waiting for the hourly sweep.
    if (req.method === 'GET' && url === '/admin/console/insights') {
      const result = await fetchAuditReports(15);
      // Hide recommendations already turned into directives.
      const applied = loadInsightsState().applied || {};
      for (const r of result.reports || []) {
        if (r.report?.proposals?.length) {
          r.report.proposals = r.report.proposals.filter(p => !applied[proposalKey(r.id, p)]);
        }
      }
      return json(res, CORS, 200, result);
    }

    // Turn a recommendation into a directive in one step and remove it from
    // the Insights list. `proposal` is the ORIGINAL recommendation text (used
    // for the dedup key); `text` is Mike's possibly-edited directive wording.
    if (req.method === 'POST' && url === '/admin/console/insights/apply') {
      const { reportId, proposal, text, expires } = JSON.parse(await readBody(req));
      if (!reportId || !proposal) return json(res, CORS, 400, { error: 'reportId and proposal are required.' });
      const directive = addDirective(text, expires);
      const state = loadInsightsState();
      state.applied = state.applied || {};
      state.applied[proposalKey(reportId, proposal)] = {
        directiveId: directive.id,
        appliedAt: new Date().toISOString(),
        text: directive.text,
      };
      saveInsightsState(state);
      console.log(`[AdminConsole] Recommendation applied as directive ${directive.id}`);
      return json(res, CORS, 200, { ok: true, directive: { ...directive, active: isDirectiveActive(directive) } });
    }

    if (req.method === 'POST' && url === '/admin/console/insights/run') {
      const body = await readBody(req);
      const { days } = body ? JSON.parse(body) : {};
      const windowDays = Math.min(Math.max(Number(days) || 1, 1), 30);
      const sinceMs = Date.now() - windowDays * 24 * 3600 * 1000;
      console.log(`[AdminConsole] On-demand transcript analysis over last ${windowDays} day(s)`);
      const result = await runTranscriptAudit(sinceMs, 'admin_console');
      return json(res, CORS, 200, { ...result, windowDays });
    }

    const directiveMatch = url.match(/^\/admin\/console\/directives\/([\w-]+)$/);
    if (req.method === 'DELETE' && directiveMatch) {
      const list = loadDirectives();
      const remaining = list.filter(d => d.id !== directiveMatch[1]);
      if (remaining.length === list.length) return json(res, CORS, 404, { error: 'Directive not found.' });
      saveDirectives(remaining);
      console.log(`[AdminConsole] Directive deleted: ${directiveMatch[1]}`);
      return json(res, CORS, 200, { ok: true });
    }

    // ─── Design loop (runs in-process; no dependence on a dev machine) ─────
    if (req.method === 'POST' && url === '/admin/console/design-loop/run') {
      // Fire-and-forget: a full run takes minutes (two Sonnet passes), far
      // longer than an HTTP request should hang. Result lands in the logs
      // and, when RESEND_API_KEY is set, in Mike's inbox.
      runDesignLoop({ email: true, trigger: 'admin_console' })
        .then(r => console.log(`[DesignLoop] On-demand run finished: ${r.changed ? 'prompt updated' : 'no changes applied'}`))
        .catch(e => console.error('[DesignLoop] On-demand run failed:', e.message));
      return json(res, CORS, 202, { ok: true, started: true, note: 'Running in the background — takes a few minutes. You will get an email if changes are applied.' });
    }

    // The design doc the loop reasons over. The repo copy isn't in the
    // production image (build context is server/), so prod keeps a
    // console-managed copy on the volume.
    if (req.method === 'GET' && url === '/admin/console/agent-md') {
      const { content, source } = readAgentMd();
      return json(res, CORS, 200, { content, source });
    }

    if (req.method === 'POST' && url === '/admin/console/agent-md') {
      const { content } = JSON.parse(await readBody(req));
      if (typeof content !== 'string' || content.trim().length < 100) {
        return json(res, CORS, 400, { error: 'agent.md content missing or suspiciously short.' });
      }
      mkdirSync(dirname(AGENT_MD_VOLUME_PATH), { recursive: true });
      writeFileSync(AGENT_MD_VOLUME_PATH, content);
      console.log(`[AdminConsole] agent.md updated on volume (${content.length} chars)`);
      return json(res, CORS, 200, { ok: true, chars: content.length });
    }

    return json(res, CORS, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[AdminConsole] Error:', err.message);
    return json(res, CORS, err.status || 500, { error: err.message });
  }
}
