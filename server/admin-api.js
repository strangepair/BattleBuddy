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
  loadInsightsState, saveInsightsState, proposalKey, listKnownProfiles,
} from './contextAgent.js';
import { runDesignLoop, AGENT_MD_VOLUME_PATH, readAgentMd } from './agentDesignLoop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const consoleHtmlPath = resolve(__dirname, 'admin-console.html');
const DESIGN_LOOP_RESULT_PATH = resolve(ADMIN_DATA_ROOT, 'design-loop-last-result.json');

function loadDesignLoopResult() {
  try { return JSON.parse(readFileSync(DESIGN_LOOP_RESULT_PATH, 'utf-8')); } catch { return null; }
}
function saveDesignLoopResult(data) {
  mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
  const existing = loadDesignLoopResult() || {};
  let history = existing.history || [];
  // Completed runs (done or error) go into the history ledger; running state doesn't
  if (data.status === 'done' || data.status === 'error') {
    history = [{ ...data }, ...history.filter(h => h.startedAt !== data.startedAt)].slice(0, 10);
  }
  writeFileSync(DESIGN_LOOP_RESULT_PATH, JSON.stringify({ ...data, history }, null, 2));
}

// Every one of these must survive a prompt edit — buildSystemPrompt fills them
// per turn, and .replace() silently no-ops on a missing placeholder, so losing
// {{profile}} would quietly erase the agent's memory of the user.
const REQUIRED_PLACEHOLDERS = [
  '{{current_goal}}', '{{profile}}', '{{trigger_context}}', '{{recent_history}}',
  '{{life_architecture}}', '{{session_context}}', '{{relevant_memories}}',
];

const MAX_DIRECTIVE_CHARS = 1000;
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

// Insights apply/dismiss state lives in contextAgent.js (loadInsightsState &
// co.) because the audit engine and design loop read it back as calibration
// feedback for future recommendations.

// ─── URL resources ────────────────────────────────────────────────────────────
// A link dropped in the Resources tab is fetched ONCE at add time and stored
// as extracted text (BB can't browse — a bare URL in the prompt is useless).

const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;

/** Admin-only endpoint, but don't let a typo'd link poke at internal services. */
function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('Not a valid URL.'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http(s) URLs are supported.'), { status: 400 });
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')
    || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host)) {
    throw Object.assign(new Error('Refusing to fetch internal/private addresses.'), { status: 400 });
  }
  return u;
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|iframe|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&#\d+;|&\w+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^-\s*$/gm, '') // empty list items left by stripped nav links
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

async function fetchUrlResource(rawUrl) {
  const u = assertSafeUrl(rawUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u.href, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'BattleBuddy-Console/1.0 (+admin resource fetch)', 'Accept': 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.5' },
    });
  } catch (e) {
    throw Object.assign(new Error(`Fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw Object.assign(new Error(`Fetch failed: HTTP ${res.status} from ${u.hostname}`), { status: 502 });

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!/text\/|application\/(xhtml|xml|json|markdown)/.test(ctype)) {
    throw Object.assign(new Error(`Unsupported content type "${ctype.split(';')[0]}" — for PDFs and other binary formats, paste the text instead.`), { status: 400 });
  }
  const raw = (await res.text()).slice(0, FETCH_MAX_BYTES);
  const isHtml = /html|xml/.test(ctype) || /^\s*</.test(raw);
  const { title, text } = isHtml ? htmlToText(raw) : { title: null, text: raw.trim() };
  if (!text || text.length < 80) {
    throw Object.assign(new Error('Fetched the page but extracted almost no text (likely a JS-rendered page) — paste the content instead.'), { status: 422 });
  }
  return { title, text, finalUrl: res.url || u.href };
}

// ─── Overview dashboard ───────────────────────────────────────────────────────

const chicagoDay = at => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(at instanceof Date ? at : new Date(at));

function safeCount(dir, filter = f => !f.startsWith('.')) {
  try { return readdirSync(dir).filter(filter).length; } catch { return 0; }
}

async function buildDashboard({ fetchDashboardEvents, fetchAuditReports }) {
  const DAYS = 14;

  // Usage: events bucketed by the user's calendar day (Railway runs UTC).
  const { events, error: eventsError } = await fetchDashboardEvents(DAYS);
  const byDay = {};
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = chicagoDay(new Date(Date.now() - i * 24 * 3600 * 1000));
    byDay[d] = { date: d, cigarettes: 0, resisted: 0, gaveIn: 0, urges: 0, sessions: 0 };
  }
  for (const e of events) {
    const day = byDay[chicagoDay(e.occurred_at)];
    if (!day) continue;
    if (e.event_type === 'cigarette') day.cigarettes++;
    else if (e.event_type === 'urge_resisted') day.resisted++;
    else if (e.event_type === 'urge_gave_in') day.gaveIn++;
    else if (e.event_type === 'urge') day.urges++;
    else if (e.event_type === 'session') day.sessions++;
  }
  const eventsByDay = Object.values(byDay);

  // Agent evolution: performance + memory trajectories from the audits.
  const { reports } = await fetchAuditReports(30);
  const num = v => {
    const m = String(v ?? '').match(/\d+(\.\d+)?/);
    return m ? Math.min(10, parseFloat(m[0])) : null;
  };
  const memoryScores = (reports || [])
    .map(r => {
      const s = num(r.report?.memory_performance?.score);
      return s !== null ? { at: r.occurredAt, score: s } : null;
    })
    .filter(Boolean)
    .reverse(); // chronological

  // Overall performance: audits now emit an explicit performance_score; for
  // reports predating it, derive a composite from what they did record —
  // memory accuracy averaged with the win/(win+failure) ratio.
  const performanceScores = (reports || [])
    .map(r => {
      const rep = r.report || {};
      const explicit = num(rep.performance_score);
      if (explicit !== null) return { at: r.occurredAt, score: explicit, derived: false };
      const wins = (rep.agent_wins || []).length;
      const fails = (rep.agent_failures || []).length;
      const parts = [];
      const mem = num(rep.memory_performance?.score);
      if (mem !== null) parts.push(mem);
      if (wins + fails > 0) parts.push(10 * wins / (wins + fails));
      if (!parts.length) return null;
      return { at: r.occurredAt, score: Math.round(parts.reduce((a, b) => a + b, 0) / parts.length * 10) / 10, derived: true };
    })
    .filter(Boolean)
    .reverse(); // chronological

  const latest = (reports || []).find(r => r.report?.summary);
  const insightsState = loadInsightsState();

  // Profiles (users the agent knows) — read from the live in-memory cache
  // (backed by Supabase's user_profiles), not the volume, which saveProfile
  // no longer writes to. listKnownProfiles() already excludes alias entries.
  const users = listKnownProfiles()
    .map(p => ({ userId: p.userId, name: p.name || null, sessions: p.session_count || 0, lastSessionAt: p.last_session_at || null }))
    .sort((a, b) => b.sessions - a.sessions);

  // Prompt + design loop state (design-loop-state.json is unrelated bookkeeping,
  // still on the volume — only the profile JSON files moved to Supabase).
  const promptContent = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  const versionMatch = promptContent.match(/PROMPT_VERSION: (v[\d.]+) — ([\d-]+)/);
  const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
  let designLoopLastRun = null;
  try { designLoopLastRun = JSON.parse(readFileSync(resolve(storeDir, 'design-loop-state.json'), 'utf-8')).last_run_at || null; } catch {}

  return {
    eventsError: eventsError || null,
    eventsByDay,
    memoryScores,
    performanceScores,
    feedback: {
      applied: Object.keys(insightsState.applied || {}).length,
      dismissed: Object.keys(insightsState.dismissed || {}).length,
    },
    latestAudit: latest ? { at: latest.occurredAt, summary: latest.report.summary } : null,
    users,
    totals: { users: users.length, sessions: users.reduce((n, u) => n + u.sessions, 0) },
    prompt: {
      version: versionMatch ? versionMatch[1] : null,
      versionDate: versionMatch ? versionMatch[2] : null,
      chars: promptContent.length,
      divergedFromRepo: promptDivergedFromRepo(promptContent),
      backups: safeCount(resolve(ADMIN_DATA_ROOT, 'prompt-backups'), f => f.endsWith('.md')),
    },
    designLoop: {
      lastRunAt: designLoopLastRun,
      proposals: safeCount(resolve(ADMIN_DATA_ROOT, 'agent-proposals'), f => f.endsWith('.md')),
      agentMdSource: readAgentMd().source,
    },
    directives: {
      active: loadDirectives().filter(d => isDirectiveActive(d)).length,
      total: loadDirectives().length,
    },
    resources: { count: safeCount(RESOURCES_DIR) },
  };
}

export async function handleAdminConsole(req, res, { checkAdminSecret, CORS, send401, runTranscriptAudit, fetchAuditReports, fetchDashboardEvents }) {
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
      const { name, content, url: sourceUrl } = JSON.parse(await readBody(req));

      let finalContent = content;
      let finalName = name;
      if (sourceUrl) {
        const { title, text, finalUrl } = await fetchUrlResource(sourceUrl);
        finalContent = `> Source: ${finalUrl} (fetched ${new Date().toISOString().slice(0, 10)})\n\n${text}`;
        if (!finalName || !String(finalName).trim()) finalName = title || new URL(finalUrl).hostname;
      }

      const target = resourcePath(finalName);
      if (!target) return json(res, CORS, 400, { error: 'Invalid resource name.' });
      if (typeof finalContent !== 'string' || !finalContent.trim()) {
        return json(res, CORS, 400, { error: 'Resource content is empty.' });
      }
      if (finalContent.length > MAX_RESOURCE_CHARS) {
        if (sourceUrl) finalContent = finalContent.slice(0, MAX_RESOURCE_CHARS) + '\n\n[truncated at size cap]';
        else return json(res, CORS, 400, { error: `Resource too large (${finalContent.length} chars, max ${MAX_RESOURCE_CHARS}).` });
      }
      mkdirSync(RESOURCES_DIR, { recursive: true });
      const existed = existsSync(target.path);
      writeFileSync(target.path, finalContent);
      console.log(`[AdminConsole] Resource ${existed ? 'updated' : 'added'}: ${target.name} (${finalContent.length} chars${sourceUrl ? `, from ${sourceUrl}` : ''})`);
      return json(res, CORS, 200, { ok: true, name: target.name, updated: existed, chars: finalContent.length, fromUrl: !!sourceUrl });
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

    // ─── Overview dashboard ────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/admin/console/dashboard') {
      return json(res, CORS, 200, await buildDashboard({ fetchDashboardEvents, fetchAuditReports }));
    }

    // ─── Insights (transcript-audit recommendations) ──────────────────────
    // Reuses the existing audit engine (runTranscriptAudit in index.js) —
    // one analysis pipeline, surfaced here so Mike can read the reports and
    // trigger a fresh pass without waiting for the hourly sweep.
    if (req.method === 'GET' && url === '/admin/console/insights') {
      const result = await fetchAuditReports(15);
      // Hide recommendations already turned into directives or dismissed.
      const state = loadInsightsState();
      const handled = { ...(state.applied || {}), ...(state.dismissed || {}) };
      for (const r of result.reports || []) {
        if (r.report?.proposals?.length) {
          r.report.proposals = r.report.proposals.filter(p => !handled[proposalKey(r.id, p)]);
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
      // `original` kept alongside the final wording: the diff between what was
      // proposed and what Mike actually applied is calibration signal for the
      // next analysis runs (buildInsightsFeedback).
      state.applied[proposalKey(reportId, proposal)] = {
        directiveId: directive.id,
        appliedAt: new Date().toISOString(),
        original: proposal,
        text: directive.text,
      };
      saveInsightsState(state);
      console.log(`[AdminConsole] Recommendation applied as directive ${directive.id}`);
      return json(res, CORS, 200, { ok: true, directive: { ...directive, active: isDirectiveActive(directive) } });
    }

    // Dismiss a recommendation: gone from the console, and recorded so future
    // analysis runs stop proposing things like it.
    if (req.method === 'POST' && url === '/admin/console/insights/dismiss') {
      const { reportId, proposal } = JSON.parse(await readBody(req));
      if (!reportId || !proposal) return json(res, CORS, 400, { error: 'reportId and proposal are required.' });
      const state = loadInsightsState();
      state.dismissed = state.dismissed || {};
      state.dismissed[proposalKey(reportId, proposal)] = {
        dismissedAt: new Date().toISOString(),
        text: proposal,
      };
      saveInsightsState(state);
      console.log(`[AdminConsole] Recommendation dismissed: "${String(proposal).slice(0, 60)}"`);
      return json(res, CORS, 200, { ok: true });
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
    if (req.method === 'GET' && url === '/admin/console/design-loop/status') {
      return json(res, CORS, 200, loadDesignLoopResult() || { status: 'never_run' });
    }

    if (req.method === 'POST' && url === '/admin/console/design-loop/run') {
      const startedAt = new Date().toISOString();
      saveDesignLoopResult({ status: 'running', startedAt, trigger: 'admin_console' });
      runDesignLoop({ email: true, trigger: 'admin_console' })
        .then(r => {
          console.log(`[DesignLoop] On-demand run finished: ${r.changed ? 'prompt updated' : 'no changes applied'}`);
          saveDesignLoopResult({
            status: 'done', startedAt, completedAt: new Date().toISOString(),
            changed: r.changed, summary: r.summary || null,
            users: r.users, sessions: r.sessions, trigger: 'admin_console',
          });
        })
        .catch(e => {
          console.error('[DesignLoop] On-demand run failed:', e.message);
          saveDesignLoopResult({ status: 'error', startedAt, completedAt: new Date().toISOString(), error: e.message, trigger: 'admin_console' });
        });
      return json(res, CORS, 202, { ok: true, started: true, startedAt, note: 'Running in the background — takes a few minutes. You will get an email if changes are applied.' });
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
