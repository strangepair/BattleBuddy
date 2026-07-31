// ─── Developer-mode build pipeline (control plane) ───────────────────────────
//
// Turns dev-mode transcripts and typed directives into structured product
// requests (Claude Sonnet), stores them + their pipeline status in Supabase
// (dev_build_requests), and dispatches GitHub Actions to actually write the
// code, open a PR, and deploy. The Dev tab in the mobile app reads/writes this
// module's routes.
//
// Execution plane = GitHub Actions (see .github/workflows/). This module never
// touches the repo directly; it only fires repository_dispatch and receives
// status callbacks from the workflows at /dev/github/webhook.
//
// Design mirrors admin-api.js (a single handle* dispatcher) and the design-loop
// scheduler pattern in index.js. GitHub is called over raw fetch — no new npm
// dependency, matching how Resend is called elsewhere.

import { createHash, timingSafeEqual } from 'node:crypto';

const SPEC_MODEL = 'claude-sonnet-4-6';

// Runtime kill switch. Defaults from env; POST /dev/pause flips it at runtime.
let PAUSED = false;

function envFlag(name, dflt = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
}

export function isPipelineEnabled() {
  return envFlag('DEV_PIPELINE_ENABLED', false) && !PAUSED;
}
function isDryRun() {
  return envFlag('DEV_PIPELINE_DRYRUN', false);
}

const GITHUB_REPO = process.env.GITHUB_REPO || 'strangepair/BattleBuddy';
const MAX_CONCURRENT = Number(process.env.DEV_MAX_CONCURRENT || 2);
const MAX_PER_DAY = Number(process.env.DEV_MAX_PER_DAY || 20);
const MIN_CONFIDENCE = Number(process.env.DEV_MIN_CONFIDENCE || 0.6);

// Paths the pipeline must never modify. Enforced hard in autobuild.yml; also
// used here to refuse obviously out-of-bounds directives up front.
const FORBIDDEN_HINTS = [
  '.github/workflows', 'eas.json', 'app store', 'signing', 'provisioning',
  'hard limits', '988', 'crisis gate', 'secret', 'credential', 'private key',
];

// ─── Small helpers ───────────────────────────────────────────────────────────

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

export function dedupeKey(target, title) {
  const norm = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${target}:${createHash('sha1').update(norm).digest('hex').slice(0, 16)}`;
}

export function looksForbidden(text) {
  let t = String(text || '').toLowerCase();
  // The spec generator dutifully caveats prompt work with "without changing
  // hard limits / crisis language" — preserve/negation phrasing about a
  // protected area is reassurance, not intent, and was flagging every
  // prompt-target request. Strip those clauses before matching; the diff-time
  // scope-fence in autobuild.yml still hard-blocks any actual violation.
  t = t.replace(
    /\b(?:without|not|never|don'?t|avoid|preserv\w*|keep\w*|leav\w*|maintain\w*|retain\w*|protect\w*)\b[^.;\n]*/g,
    ' ',
  );
  return FORBIDDEN_HINTS.some((h) => t.includes(h));
}

// ─── In-batch near-duplicate collapse ────────────────────────────────────────

function normalizeWords(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function jaccardOverlap(wordsA, wordsB) {
  if (wordsA.length === 0 && wordsB.length === 0) return 1;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function collapseNearDuplicates(items) {
  const dropped = new Set();
  for (let i = 0; i < items.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (dropped.has(j)) continue;
      if (items[i].target !== items[j].target) continue;
      const wordsA = normalizeWords((items[i].title || '') + ' ' + (items[i].description || ''));
      const wordsB = normalizeWords((items[j].title || '') + ' ' + (items[j].description || ''));
      if (jaccardOverlap(wordsA, wordsB) > 0.6) {
        const keepI = (items[i].confidence || 0) >= (items[j].confidence || 0);
        dropped.add(keepI ? j : i);
      }
    }
  }
  return items.filter((_, idx) => !dropped.has(idx));
}

// ─── Spec generation (transcript | directive → product requests) ─────────────

const SPEC_SYSTEM = `You convert product feedback for the BattleBuddy mobile app into concrete, buildable engineering tasks.

BattleBuddy = React Native/Expo app (mobile/) + Node backend (server/) + a Python voice agent (agent/) + Supabase. A separate autonomous pipeline will implement each task you emit, so be precise and conservative.

Return ONLY a JSON array. Each element:
{
  "title": short imperative summary (<= 80 chars),
  "target": one of "backend" | "agent" | "ui" | "prompt",
      // ui = mobile app (mobile/), backend = server (server/), agent = voice agent or the
      // agent design-loop/system prompt behaviour, prompt = wording-only tweak to the system prompt
  "description": 1-3 sentences of what to change and why,
  "acceptanceCriteria": [ "testable statements" ],
  "affectedFiles": [ "best-guess repo paths" ],
  "claudeCodePrompt": a self-contained instruction an autonomous coding agent can execute in the repo,
  "confidence": 0.0-1.0 how clearly this is an actionable, well-scoped request
}

Rules:
- Only emit tasks that are genuinely actionable software changes. If the input is casual conversation with no clear change request, return [].
- Prefer the SMALLEST change that satisfies the request. One task per distinct change.
- NEVER emit tasks that touch CI/deploy workflows, signing/secrets, app-store config, or that weaken the app's crisis/safety footing (the 988 off-ramp, "## Hard limits"). If the request implies those, lower confidence to 0 and omit it.
- Additive, reversible changes only. No destructive DB migrations.`;

// Exported for devCapture.js (server-side dev-mode capture) and tests.
export async function generateProductRequests(anthropic, { transcript, directiveText }) {
  const userContent = directiveText
    ? `A developer typed this directive:\n\n"""${directiveText}"""\n\nEmit the JSON array of tasks.`
    : `Here is a developer-mode conversation transcript. Extract any concrete change requests.\n\n"""${(transcript || [])
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n')
        .slice(0, 12000)}"""\n\nEmit the JSON array of tasks.`;

  const resp = await anthropic.messages.create({
    model: SPEC_MODEL,
    max_tokens: 8000,
    system: SPEC_SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });

  const rawText = resp.content?.map((b) => (b.type === 'text' ? b.text : '')).join('') || '';

  if (resp.stop_reason === 'max_tokens') {
    console.error('[devPipeline] TRUNCATED: stop_reason=max_tokens, raw:', rawText);
    return [];
  }

  let arr;
  try {
    const start = rawText.indexOf('[');
    const end = rawText.lastIndexOf(']');
    arr = JSON.parse(rawText.slice(start, end + 1));
  } catch (err) {
    console.error('[devPipeline] JSON.parse failed:', err.message, 'raw:', rawText);
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const items = arr
    .filter((t) => t && t.title && t.target && typeof t.confidence === 'number')
    .filter((t) => ['backend', 'agent', 'ui', 'prompt'].includes(t.target))
    .map((t) => ({
      ...t,
      // Any whiff of a forbidden area → flag for a human instead of building.
      forbidden:
        looksForbidden(t.title) ||
        looksForbidden(t.description) ||
        looksForbidden(t.claudeCodePrompt) ||
        (t.affectedFiles || []).some(looksForbidden),
    }));

  return collapseNearDuplicates(items);
}

// ─── Persistence (Supabase dev_build_requests) ───────────────────────────────

// Exported for devCapture.js (server-side dev-mode capture) and tests.
export async function insertRequests(supabase, { source, userId, sessionId }, tasks) {
  if (!supabase || tasks.length === 0) return [];

  // Skip duplicates of anything already open (not deployed/failed).
  const keys = tasks.map((t) => dedupeKey(t.target, t.title));
  const { data: existing } = await supabase
    .from('dev_build_requests')
    .select('dedupe_key')
    .in('dedupe_key', keys)
    .not('status', 'in', '(deployed,failed)');
  const seen = new Set((existing || []).map((r) => r.dedupe_key));

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const pendingTasks = tasks.filter((t) => !seen.has(dedupeKey(t.target, t.title)));
  const finalTasks = [];
  for (const t of pendingTasks) {
    const key = dedupeKey(t.target, t.title);
    const { data: deployedRows } = await supabase
      .from('dev_build_requests')
      .select('id')
      .eq('dedupe_key', key)
      .eq('status', 'deployed')
      .gte('updated_at', fourteenDaysAgo)
      .limit(1);
    if (deployedRows && deployedRows.length > 0) {
      console.log('[devPipeline] skip insert: recently deployed dedupe_key:', key);
      continue;
    }
    finalTasks.push(t);
  }

  const rows = finalTasks
    .map((t) => ({
      source,
      user_id: userId ? String(userId) : null,
      session_id: sessionId || null,
      title: String(t.title).slice(0, 200),
      target: t.target,
      description: t.description || null,
      confidence: t.confidence,
      spec: {
        acceptanceCriteria: t.acceptanceCriteria || [],
        affectedFiles: t.affectedFiles || [],
        claudeCodePrompt: t.claudeCodePrompt || t.description || t.title,
      },
      dedupe_key: dedupeKey(t.target, t.title),
      // Forbidden or low-confidence → park it for a human rather than build.
      status: t.forbidden
        ? 'needs_attention'
        : t.confidence < MIN_CONFIDENCE
        ? 'needs_attention'
        : 'pending',
      error: t.forbidden ? 'Touches a protected area (CI/secrets/safety) — needs human review.' : null,
      history: [{ at: new Date().toISOString(), to: 'created', note: source }],
    }));

  if (rows.length === 0) return [];
  const { data, error } = await supabase.from('dev_build_requests').insert(rows).select('*');
  if (error) {
    console.error('[devPipeline] insert failed:', error.message);
    return [];
  }
  return data || [];
}

function publicRow(r) {
  return {
    id: r.id,
    title: r.title,
    target: r.target,
    status: r.status,
    source: r.source,
    description: r.description,
    pr_url: r.pr_url,
    pr_number: r.pr_number,
    branch: r.branch,
    deploy_status: r.deploy_status,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function setStatus(supabase, id, patch, note) {
  if (!supabase) return;
  const { data: cur } = await supabase
    .from('dev_build_requests')
    .select('status, history')
    .eq('id', id)
    .single();
  const history = Array.isArray(cur?.history) ? cur.history : [];
  history.push({ at: new Date().toISOString(), from: cur?.status, to: patch.status, note: note || null });
  await supabase
    .from('dev_build_requests')
    .update({ ...patch, updated_at: new Date().toISOString(), history })
    .eq('id', id);
}

// ─── GitHub dispatch (raw REST, no dependency) ───────────────────────────────

async function dispatchBuild(request) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'dev_build',
      client_payload: {
        requestId: request.id,
        target: request.target,
        title: request.title,
        // Keep the payload small — client_payload is size-limited.
        prompt: (request.spec?.claudeCodePrompt || '').slice(0, 6000),
        acceptance: (request.spec?.acceptanceCriteria || []).slice(0, 10),
        files: (request.spec?.affectedFiles || []).slice(0, 20),
        dryRun: isDryRun(),
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`github dispatch ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ─── Build worker (scheduled tick) ───────────────────────────────────────────
// Follows runScheduledDesignLoop: cheap, idempotent, swallows errors.

export async function runDevBuildWorker(deps) {
  const { supabase } = deps;
  if (!supabase || !isPipelineEnabled()) return;

  // Concurrency + daily-rate gates.
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ count: inflight }, { count: today }] = await Promise.all([
    supabase.from('dev_build_requests').select('*', { count: 'exact', head: true })
      .in('status', ['building', 'in_review', 'merging', 'deploying']),
    supabase.from('dev_build_requests').select('*', { count: 'exact', head: true })
      .gte('created_at', dayAgo).neq('status', 'needs_attention'),
  ]);
  if ((inflight || 0) >= MAX_CONCURRENT) return;
  if ((today || 0) >= MAX_PER_DAY) return;

  const slots = MAX_CONCURRENT - (inflight || 0);
  const { data: pending } = await supabase
    .from('dev_build_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(slots);

  for (const req of pending || []) {
    try {
      await dispatchBuild(req);
      await setStatus(supabase, req.id, { status: 'building' }, 'dispatched to GitHub Actions');
    } catch (err) {
      await setStatus(supabase, req.id, { status: 'failed', error: String(err.message).slice(0, 300) }, 'dispatch failed');
    }
  }
}

// ─── Status callback auth (workflows → backend) ──────────────────────────────

function checkStatusToken(req) {
  const provided = (req.headers['x-bb-status-token'] || '').toString();
  const expected = process.env.BB_STATUS_WEBHOOK_TOKEN || '';
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Map a workflow "event" to a status patch.
export function patchForEvent(evt, payload) {
  switch (evt) {
    case 'pr_opened':
      return { status: 'in_review', pr_url: payload.pr_url, pr_number: payload.pr_number, branch: payload.branch, checks_status: 'running' };
    case 'checks_passed':
      return { status: 'merging', checks_status: 'passed' };
    case 'checks_failed':
      return { status: 'failed', checks_status: 'failed', error: (payload.error || 'CI failed').slice(0, 300) };
    case 'merged':
      return { status: 'deploying' };
    case 'deployed':
      return { status: 'deployed', deploy_status: payload.deploy_status || 'ok' };
    case 'deploy_failed':
      return { status: 'failed', deploy_status: 'failed', error: (payload.error || 'deploy failed').slice(0, 300) };
    case 'needs_attention':
      return { status: 'needs_attention', error: (payload.error || 'blocked').slice(0, 300) };
    default:
      return null;
  }
}

// ─── HTTP dispatcher (mounted at /dev/* in index.js) ─────────────────────────

export async function handleDevPipeline(req, res, deps) {
  const { CORS, checkClientToken, checkAdminSecret, anthropic, supabase, resolveUserId } = deps;
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  const json = (status, obj) => {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // POST /dev/capture — dev-mode transcript → product requests (async).
  if (req.method === 'POST' && path === '/dev/capture') {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    const body = await readBody(req);
    // Respond immediately; generation + insert happen in the background.
    json(202, { ok: true });
    (async () => {
      try {
        const tasks = await generateProductRequests(anthropic, { transcript: body.messages });
        await insertRequests(supabase, {
          source: 'transcript',
          userId: resolveUserId ? resolveUserId(body.userId) : body.userId,
          sessionId: body.sessionId,
        }, tasks);
      } catch (err) {
        console.error('[devPipeline] capture processing failed:', err.message);
      }
    })();
    return;
  }

  // POST /dev/directive — typed directive → product request(s).
  if (req.method === 'POST' && path === '/dev/directive') {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    const body = await readBody(req);
    const text = (body.text || '').toString().trim();
    if (!text) return json(400, { error: 'text required' });
    try {
      const tasks = await generateProductRequests(anthropic, { directiveText: text });
      const rows = await insertRequests(supabase, {
        source: 'directive',
        userId: resolveUserId ? resolveUserId(body.userId) : body.userId,
        sessionId: null,
      }, tasks);
      return json(200, { requests: rows.map(publicRow) });
    } catch (err) {
      return json(500, { error: err.message });
    }
  }

  // GET /dev/requests — list for the Dev tab.
  if (req.method === 'GET' && path === '/dev/requests') {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    if (!supabase) return json(200, { requests: [] });
    const { data } = await supabase
      .from('dev_build_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    return json(200, { requests: (data || []).map(publicRow), enabled: isPipelineEnabled(), dryRun: isDryRun() });
  }

  // GET /dev/requests/:id
  if (req.method === 'GET' && path.startsWith('/dev/requests/')) {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    if (!supabase) return json(404, { error: 'not found' });
    const id = decodeURIComponent(path.slice('/dev/requests/'.length));
    const { data } = await supabase.from('dev_build_requests').select('*').eq('id', id).single();
    if (!data) return json(404, { error: 'not found' });
    return json(200, { request: publicRow(data) });
  }

  // POST /dev/github/webhook — status callbacks from the GitHub workflows.
  if (req.method === 'POST' && path === '/dev/github/webhook') {
    if (!checkStatusToken(req)) return json(401, { error: 'unauthorized' });
    const body = await readBody(req);
    const { requestId, event, ...payload } = body;
    const patch = patchForEvent(event, payload);
    if (!requestId || !patch) return json(400, { error: 'requestId and known event required' });
    await setStatus(supabase, requestId, patch, `gh:${event}`);
    return json(200, { ok: true });
  }

  // POST /dev/pause — runtime kill switch (admin only).
  if (req.method === 'POST' && path === '/dev/pause') {
    if (!checkAdminSecret(req)) return json(401, { error: 'unauthorized' });
    const body = await readBody(req);
    PAUSED = body.paused !== false;
    return json(200, { paused: PAUSED, enabled: isPipelineEnabled() });
  }

  return json(404, { error: 'not found' });
}
