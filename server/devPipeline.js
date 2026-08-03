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
//
// Triage layer (added 2026-08): every submission is durably recorded in the
// `submissions` + `pipeline_events` tables BEFORE any other processing. A
// classification call then routes to an existing work item (duplicate) or
// creates a new one. See: insertSubmission, triageSubmission, handleRepetition.

import { createHash, timingSafeEqual } from 'node:crypto';
import { githubFetch } from './githubApi.js';
import { startRelease, completeRelease } from './devRelease.js';

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

// ─── Self-heal tuning (migration 020) ────────────────────────────────────────
// Retries are per failure CLASS, never blanket. An unrecognised failure is
// treated as terminal on purpose: a pipeline that retries what it doesn't
// understand burns build minutes and hides the real fault.
const RETRY_BASE_MS = Number(process.env.DEV_RETRY_BASE_MS || 5 * 60 * 1000);
const MAX_RETRIES = { transient: 2, stale_branch: 1, terminal: 0 };
// N consecutive failures sharing a signature trip the breaker: stop retrying,
// raise ONE alert. This is what would have caught the IPv6 SUPABASE_DB_URL
// break after the first row instead of the fifth.
const BREAKER_THRESHOLD = Number(process.env.DEV_BREAKER_THRESHOLD || 3);
const BREAKER_WINDOW_MS = Number(process.env.DEV_BREAKER_WINDOW_MS || 6 * 3600 * 1000);

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

  // Skip a task when its dedupe_key matches either (a) a row that is still
  // open — anything not deployed/failed — or (b) a row that already reached
  // 'deployed' recently. (b) is what let the dashboard broadcast feature ship
  // twice on 2026-07-31: once #37 deployed, the old "open rows only" filter
  // happily re-admitted the same change under a reworded title.
  //
  // One query, filtered in JS, rather than a lookup per task: the row count
  // per batch is tiny and an N+1 against Supabase costs a round trip each.
  const keys = tasks.map((t) => dedupeKey(t.target, t.title));
  const { data: existing } = await supabase
    .from('dev_build_requests')
    .select('dedupe_key, status, updated_at')
    .in('dedupe_key', keys);

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const seen = new Set();
  for (const r of existing || []) {
    const stillOpen = r.status !== 'deployed' && r.status !== 'failed';
    const recentlyDeployed = r.status === 'deployed' && r.updated_at && r.updated_at >= fourteenDaysAgo;
    if (stillOpen || recentlyDeployed) {
      if (recentlyDeployed) console.log('[devPipeline] skip insert: recently deployed dedupe_key:', r.dedupe_key);
      seen.add(r.dedupe_key);
    }
  }

  const rows = tasks
    .filter((t) => !seen.has(dedupeKey(t.target, t.title)))
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
    archived: r.archived ?? false,
    changeSummary: r.change_summary ?? null,
    attempts: r.attempts ?? 0,
    failure_class: r.failure_class ?? null,
    next_retry_at: r.next_retry_at ?? null,
    // Build-train fields (migration 022): which release carried this change,
    // whether it skipped the train, and the work item it implements.
    release_id: r.release_id ?? null,
    work_item_id: r.work_item_id ?? null,
    expedite: r.expedite ?? false,
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

// ─── Manual resubmit ─────────────────────────────────────────────────────────

/** Statuses a human is allowed to retry from. */
export const RESUBMITTABLE = ['failed', 'needs_attention'];

/**
 * Which action actually un-sticks this request.
 *
 * A deploy failure means the code is already merged — regenerating it would
 * write the same change twice. Re-running the Deploy workflow for the merge
 * commit is the only correct repair. Everything else (checks failed, stale
 * branch, dispatch never landed) needs a fresh build off current main.
 */
export function resubmitPlan(row) {
  if (!row) return null;
  if (row.deploy_status === 'failed' && row.pr_number) return 'rerun_deploy';
  return 'redispatch_build';
}

/** Re-run the Deploy workflow for the merge commit of this request's PR. */
async function rerunDeploy(row) {
  const prRes = await githubFetch(`https://api.github.com/repos/${GITHUB_REPO}/pulls/${row.pr_number}`);
  const pr = await prRes.json();
  const sha = pr.merge_commit_sha;
  if (!sha) throw new Error('PR has no merge commit yet — nothing to redeploy');

  const runsRes = await githubFetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/deploy.yml/runs?head_sha=${sha}&per_page=1`,
  );
  const runs = await runsRes.json();
  const runId = runs.workflow_runs && runs.workflow_runs[0] && runs.workflow_runs[0].id;
  if (!runId) throw new Error(`no Deploy run found for merge commit ${sha.slice(0, 7)}`);

  await githubFetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${runId}/rerun-failed-jobs`,
    { method: 'POST' },
  );
}

// ─── Failure classification + circuit breaker ────────────────────────────────
//
// Order matters: terminal wins over everything. A scope-fence violation that
// happens to mention a timeout must never be retried, so the terminal patterns
// are tested first and anything unrecognised falls through to terminal too.

const TERMINAL_HINTS = [
  /scope fence/i, /protected path/i, /destructive migration/i,
  /forbidden/i, /safety marker/i, /\b988\b/,
];
const STALE_BRANCH_HINTS = [
  /merge conflict/i, /not mergeable/i, /\bdirty\b/i, /add\/add/i,
  /rebase/i, /conflict/i, /behind .*base/i,
];
const TRANSIENT_HINTS = [
  /ETIMEDOUT/i, /ECONNRESET/i, /ECONNREFUSED/i, /ENOTFOUND/i, /EAI_AGAIN/i,
  /EPIPE/i, /socket hang up/i, /network is unreachable/i, /timed?\s?out/i,
  /github dispatch 5\d\d/i, /\b(502|503|504)\b/, /rate limit/i,
  /npm\s+err/i, /onnxruntime/i, /fetch failed/i,
];

/** One of 'terminal' | 'stale_branch' | 'transient'. Unknown → terminal. */
export function classifyFailure(errorText) {
  const text = String(errorText || '');
  if (!text) return 'terminal';
  if (TERMINAL_HINTS.some((re) => re.test(text))) return 'terminal';
  if (STALE_BRANCH_HINTS.some((re) => re.test(text))) return 'stale_branch';
  if (TRANSIENT_HINTS.some((re) => re.test(text))) return 'transient';
  return 'terminal';
}

/** Stable fingerprint for "this failed the same way". Volatile bits (ids,
    numbers, paths, timestamps) are stripped so repeats collapse onto one key. */
export function failureSignature(stage, errorText) {
  const normalized = String(errorText || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/(\/[\w.-]+)+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const hash = createHash('sha1').update(`${stage}|${normalized}`).digest('hex').slice(0, 16);
  return { signature: `${stage}:${hash}`, normalized };
}

/** Exponential backoff on the attempt count already recorded. */
export function retryDelayMs(attempts) {
  return RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts));
}

/** True when an unresolved alert already exists for this signature. */
async function isBreakerOpen(supabase, signature) {
  const { data } = await supabase
    .from('pipeline_alerts')
    .select('id')
    .eq('signature', signature)
    .is('resolved_at', null)
    .limit(1);
  return (data || []).length > 0;
}

/** Count recent failed rows sharing a signature; trip the breaker at the
    threshold. Raising the alert relies on the partial unique index from
    migration 020 — a duplicate insert is expected and swallowed, so two
    concurrent ticks cannot double-alert. */
async function maybeTripBreaker(supabase, signature, normalized, stage) {
  const since = new Date(Date.now() - BREAKER_WINDOW_MS).toISOString();
  const { data: recent } = await supabase
    .from('dev_build_requests')
    .select('id')
    .eq('failure_signature', signature)
    .gte('updated_at', since);

  const count = (recent || []).length;
  if (count < BREAKER_THRESHOLD) return false;

  const { error } = await supabase.from('pipeline_alerts').insert({
    kind: 'repeated_failure',
    signature,
    detail: { stage, normalized, count, threshold: BREAKER_THRESHOLD },
  });
  // 23505 = unique violation: an alert for this signature is already open.
  if (error && !/duplicate key|23505/i.test(error.message || '')) {
    console.error('[devPipeline] breaker alert insert failed:', error.message);
  }

  // Stop the bleeding: nothing with this signature retries again until a human
  // (or a later success) resolves the alert.
  await supabase
    .from('dev_build_requests')
    .update({ next_retry_at: null, status: 'needs_attention', updated_at: new Date().toISOString() })
    .eq('failure_signature', signature)
    .eq('status', 'failed');

  console.error(`[devPipeline] CIRCUIT BREAKER open for ${signature} (${count} failures at ${stage})`);
  return true;
}

/** Record a failure with its class, signature and (if retryable) next attempt
    time. Replaces a bare setStatus on every failure path. */
export async function applyFailure(supabase, id, patch, note, stage) {
  const { data: cur } = await supabase
    .from('dev_build_requests')
    .select('attempts')
    .eq('id', id)
    .single();
  const attempts = cur?.attempts ?? 0;

  const errorText = patch.error || note || '';
  const failureClass = classifyFailure(errorText);
  const { signature, normalized } = failureSignature(stage, errorText);

  const cap = MAX_RETRIES[failureClass] ?? 0;
  const breakerOpen = await isBreakerOpen(supabase, signature);
  const retryable = attempts < cap && !breakerOpen;

  await setStatus(
    supabase,
    id,
    {
      ...patch,
      failure_class: failureClass,
      failure_signature: signature,
      next_retry_at: retryable ? new Date(Date.now() + retryDelayMs(attempts)).toISOString() : null,
    },
    `${note}${retryable ? ` — retry ${attempts + 1}/${cap} scheduled` : ` — terminal (${failureClass})`}`,
  );

  await maybeTripBreaker(supabase, signature, normalized, stage);
}

/** Clear any open alert once the same signature succeeds again. */
async function resolveAlert(supabase, signature) {
  if (!signature) return;
  await supabase
    .from('pipeline_alerts')
    .update({ resolved_at: new Date().toISOString() })
    .eq('signature', signature)
    .is('resolved_at', null);
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
    await attemptDispatch(supabase, req, 'dispatched to GitHub Actions');
  }

  // ── Retry pass ────────────────────────────────────────────────────────────
  // Re-pick failed rows whose class is retryable and whose backoff has expired.
  // A row only reaches here if applyFailure set next_retry_at, which it does
  // only for transient / stale_branch under the per-class cap and only while
  // the breaker for its signature is closed. Both classes re-dispatch: autobuild
  // branches from current main, so a regenerated build resolves a stale-branch
  // conflict by construction.
  const retrySlots = slots - (pending || []).length;
  if (retrySlots <= 0) return;

  const { data: dueRetries } = await supabase
    .from('dev_build_requests')
    .select('*')
    .eq('status', 'failed')
    .in('failure_class', ['transient', 'stale_branch'])
    .not('next_retry_at', 'is', null)
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(retrySlots);

  for (const req of dueRetries || []) {
    const cap = MAX_RETRIES[req.failure_class] ?? 0;
    if ((req.attempts ?? 0) >= cap) {
      // Defensive: cap reached but next_retry_at was left set.
      await setStatus(supabase, req.id, { next_retry_at: null }, 'retry budget exhausted');
      continue;
    }
    await attemptDispatch(
      supabase,
      req,
      `retry ${(req.attempts ?? 0) + 1}/${cap} after ${req.failure_class} failure`,
      (req.attempts ?? 0) + 1,
    );
  }
}

/** Dispatch one request, recording success or a classified failure. */
async function attemptDispatch(supabase, req, note, attempts) {
  try {
    await dispatchBuild(req);
    await setStatus(
      supabase,
      req.id,
      {
        status: 'building',
        next_retry_at: null,
        ...(attempts === undefined ? {} : { attempts }),
      },
      note,
    );
    // A success on this signature clears its breaker.
    await resolveAlert(supabase, req.failure_signature);
  } catch (err) {
    await applyFailure(
      supabase,
      req.id,
      {
        status: 'failed',
        error: String(err.message).slice(0, 300),
        ...(attempts === undefined ? {} : { attempts }),
      },
      'dispatch failed',
      'dispatch',
    );
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
      return { status: 'in_review', pr_url: payload.pr_url, pr_number: payload.pr_number, branch: payload.branch, checks_status: 'running', ...(payload.change_summary != null ? { change_summary: String(payload.change_summary).slice(0, 1000) } : {}) };
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

// ─── Triage layer ────────────────────────────────────────────────────────────
// insertSubmission — durably record a raw submission + 'submitted' event.
// Returns { submissionId } or throws (caller must decide what to surface).
export async function insertSubmission(supabase, { source, rawText, sessionId }) {
  const { data: sub, error: subErr } = await supabase
    .from('submissions')
    .insert({ source, raw_text: rawText, session_id: sessionId || null })
    .select('id')
    .single();
  if (subErr) throw new Error(`submissions insert: ${subErr.message}`);

  // We need a work_item_id for the pipeline_events FK, but we don't have one
  // yet. We store a sentinel row on the submissions table; the 'submitted' event
  // for a specific work item is emitted later (triageSubmission). This function
  // only guarantees the submission row exists.
  return { submissionId: sub.id };
}

// emitEvent — append a row to pipeline_events.
async function emitEvent(supabase, { kind, workItemId, detail }) {
  const { error } = await supabase
    .from('pipeline_events')
    .insert({ kind, work_item_id: workItemId, detail: detail || {} });
  if (error) console.error('[devPipeline] emitEvent failed:', error.message);
}

const TRIAGE_SYSTEM = `You are a triage assistant for the BattleBuddy developer pipeline.

Given a new submission and a list of open work items, decide if the submission describes the same issue as an existing work item (duplicate) or represents a new distinct issue.

Return ONLY valid JSON — no markdown, no explanation — with this exact shape:
{"classification":"duplicate","target_work_item_id":"<uuid>"}
or
{"classification":"new","title":"<short imperative title ≤80 chars>","interpretation":"<1-3 sentence description>","subsystem":"<one of: voice|calendar|logging|dashboard|pipeline|other>"}

subsystem must be one of: voice, calendar, logging, dashboard, pipeline, other.
classification must be exactly "duplicate" or "new".
When duplicate, target_work_item_id must be the UUID of the matching work item.`;

// triageSubmission — call Claude to classify, return parsed JSON or default to 'new'.
export async function triageSubmission(anthropic, { rawText, openWorkItems }) {
  const itemsSnapshot = (openWorkItems || []).slice(0, 30).map((wi) => ({
    id: wi.id,
    title: wi.title,
    interpretation: wi.interpretation,
    subsystem: wi.subsystem,
    stage: wi.stage,
  }));

  const userContent = `Open work items (JSON array, up to 30):\n${JSON.stringify(itemsSnapshot)}\n\nNew submission:\n"""${rawText}"""\n\nReturn classification JSON.`;

  async function callModel(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await anthropic.messages.create(
        { model: SPEC_MODEL, max_tokens: 1000, system: TRIAGE_SYSTEM, messages },
        { signal: controller.signal },
      );
      clearTimeout(timer);
      return resp.content?.map((b) => (b.type === 'text' ? b.text : '')).join('') || '';
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  function parse(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!['duplicate', 'new'].includes(parsed.classification)) return null;
    if (parsed.classification === 'duplicate' && !parsed.target_work_item_id) return null;
    return parsed;
  }

  const VALID_SUBSYSTEMS = ['voice', 'calendar', 'logging', 'dashboard', 'pipeline', 'other'];
  const defaultNew = { classification: 'new', title: rawText.slice(0, 80), interpretation: rawText, subsystem: 'other' };

  try {
    const firstMessages = [{ role: 'user', content: userContent }];
    const firstText = await callModel(firstMessages);
    let result;
    try {
      result = parse(firstText);
    } catch {
      result = null;
    }

    if (!result) {
      const retryMessages = [
        ...firstMessages,
        { role: 'assistant', content: firstText },
        { role: 'user', content: 'The response was not valid JSON matching the required schema. Return ONLY the JSON object, no other text.' },
      ];
      try {
        const secondText = await callModel(retryMessages);
        try {
          result = parse(secondText);
        } catch {
          result = null;
        }
      } catch {
        result = null;
      }
    }

    if (!result) return defaultNew;
    if (result.classification === 'new') {
      result.subsystem = VALID_SUBSYSTEMS.includes(result.subsystem) ? result.subsystem : 'other';
      result.title = (result.title || rawText).slice(0, 80);
      result.interpretation = result.interpretation || rawText;
    }
    return result;
  } catch (err) {
    console.error('[devPipeline] triage error (defaulting to new):', err.message);
    return defaultNew;
  }
}

// handleRepetition — if >= 3 work items (new or evidence) for a subsystem in 7
// days and no open root-cause investigation exists, create one.
export async function handleRepetition(supabase, subsystem) {
  if (!supabase) return;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const { data: recentItems } = await supabase
    .from('work_items')
    .select('id')
    .eq('subsystem', subsystem)
    .gte('created_at', sevenDaysAgo);

  const count = (recentItems || []).length;
  if (count < 3) return;

  const rcTitle = `Root-cause investigation: ${subsystem}`;
  const { data: existing } = await supabase
    .from('work_items')
    .select('id')
    .eq('title', rcTitle)
    .not('stage', 'in', '("archived","live","rolled_back")')
    .limit(1);

  if ((existing || []).length > 0) return;

  const { data: rcItem, error: rcErr } = await supabase
    .from('work_items')
    .insert({ title: rcTitle, subsystem: 'pipeline', stage: 'received', interpretation: `Repeated reports (${count} in last 7 days) for subsystem: ${subsystem}. Root-cause investigation needed.` })
    .select('id')
    .single();

  if (rcErr) {
    console.error('[devPipeline] handleRepetition: work_item insert failed:', rcErr.message);
    return;
  }

  await emitEvent(supabase, {
    kind: 'submitted',
    workItemId: rcItem.id,
    detail: { reason: 'repetition_marker', subsystem, recent_count: count, linked_item_ids: (recentItems || []).map((r) => r.id) },
  });
}

// holdDuplicateRequests — park the dev_build_requests rows a duplicate
// submission already created so no redundant build is dispatched.
//
// Why this is needed: the /dev/directive handler calls insertRequests() BEFORE
// triage runs, so the rows exist by the time we learn the submission is a
// duplicate. Returning early from the duplicate path only skips dispatchFn,
// which is a no-op that returns an id — the real dispatch is runDevBuildWorker,
// a scheduled tick that picks up anything still in 'pending'. Without this the
// duplicate ships a second, identical build.
//
// 'duplicate' is a terminal status (migration 019); the worker only selects
// 'pending', so parked rows are never dispatched and never retried.
export async function holdDuplicateRequests(supabase, insertedRequests, targetItem) {
  if (!supabase || !targetItem) return;
  for (const row of insertedRequests || []) {
    if (!row?.id) continue;
    await setStatus(
      supabase,
      row.id,
      { status: 'duplicate' },
      `duplicate of work item ${targetItem.id} (${targetItem.title}) — attached as evidence, no build dispatched`,
    );
  }
}

// processSubmission — the main triage entry point. Called from handleDevPipeline
// for the /dev/requests (directive) submission path.
//
// Steps:
//  1. Durably record the submission row + a 'submitted' sentinel event (using a
//     temporary placeholder work item if needed — see NOTE below).
//  2. Triage (classify). On any error → default to 'new'.
//  3. Duplicate path: attach submission as evidence, emit 'submitted' event on
//     the existing work item, park any pre-created build requests so the worker
//     never dispatches them. Return { isDuplicate: true, workItem }.
//  4. New path: create work_item, link submission as 'origin', emit events,
//     then create dev_build_request + dispatch (same as today).
//  5. Repetition check.
//
// NOTE on pipeline_events FK: pipeline_events.work_item_id is NOT NULL. We
// defer the 'submitted' sentinel until we have a real work_item_id (step 3/4).
// The durability guarantee is met by the submissions row being written in step 1
// before any further processing.
export async function processSubmission(supabase, anthropic, {
  source, rawText, sessionId, source_meta,
  tasks, insertedRequests, dispatchFn,
}) {
  // ── Step 1: durable submission row ────────────────────────────────────────
  let submissionId;
  try {
    const result = await insertSubmission(supabase, { source, rawText, sessionId });
    submissionId = result.submissionId;
  } catch (err) {
    console.error('[devPipeline] DURABILITY: submissions insert failed:', err.message);
    // Can't proceed without a trace — surface the error.
    throw err;
  }

  // ── Step 2: fetch open work items for triage ──────────────────────────────
  let openWorkItems = [];
  try {
    const { data } = await supabase
      .from('work_items')
      .select('id, title, interpretation, subsystem, stage')
      .not('stage', 'in', '("archived","live","rolled_back")')
      .order('created_at', { ascending: false })
      .limit(30);
    openWorkItems = data || [];
  } catch (err) {
    console.error('[devPipeline] triage: failed to fetch work_items:', err.message);
  }

  // ── Step 3: classify ──────────────────────────────────────────────────────
  let classification;
  try {
    classification = await triageSubmission(anthropic, { rawText, openWorkItems });
  } catch (err) {
    console.error('[devPipeline] triageSubmission threw (defaulting to new):', err.message);
    classification = { classification: 'new', title: rawText.slice(0, 80), interpretation: rawText, subsystem: 'other' };
  }

  // ── Step 4a: duplicate path ───────────────────────────────────────────────
  if (classification.classification === 'duplicate') {
    const targetId = classification.target_work_item_id;
    const { data: targetItem } = await supabase
      .from('work_items')
      .select('id, title, subsystem')
      .eq('id', targetId)
      .single();

    if (!targetItem) {
      console.warn('[devPipeline] triage duplicate target not found, falling back to new:', targetId);
      classification = { classification: 'new', title: rawText.slice(0, 80), interpretation: rawText, subsystem: 'other' };
    } else {
      await supabase.from('work_item_submissions').insert({ work_item_id: targetId, submission_id: submissionId, role: 'evidence' });
      await emitEvent(supabase, { kind: 'submitted', workItemId: targetId, detail: { submission_id: submissionId, classification: 'duplicate' } });
      await holdDuplicateRequests(supabase, insertedRequests, targetItem);
      await handleRepetition(supabase, targetItem.subsystem);
      return { isDuplicate: true, existingWorkItem: targetItem };
    }
  }

  // ── Step 4b: new path ─────────────────────────────────────────────────────
  const { title, interpretation, subsystem = 'other' } = classification;

  let workItem;
  try {
    const { data: wi, error: wiErr } = await supabase
      .from('work_items')
      .insert({ title: (title || rawText).slice(0, 200), interpretation: interpretation || rawText, subsystem, stage: 'received' })
      .select('id, title, subsystem')
      .single();
    if (wiErr) throw new Error(wiErr.message);
    workItem = wi;
  } catch (err) {
    // Durability: record the failure before rethrowing.
    console.error('[devPipeline] work_item insert failed for submission', submissionId, ':', err.message);
    throw err;
  }

  await supabase.from('work_item_submissions').insert({ work_item_id: workItem.id, submission_id: submissionId, role: 'origin' });
  await emitEvent(supabase, { kind: 'submitted', workItemId: workItem.id, detail: { submission_id: submissionId, classification: 'new' } });

  // Mark as 'understood' now that interpretation is written.
  await supabase.from('work_items').update({ stage: 'understood', updated_at: new Date().toISOString() }).eq('id', workItem.id);
  await emitEvent(supabase, { kind: 'understood', workItemId: workItem.id, detail: { interpretation } });

  // ── Step 4c: build request + dispatch (existing flow) ─────────────────────
  let dispatchedRequestId = null;
  try {
    if (typeof dispatchFn === 'function') {
      dispatchedRequestId = await dispatchFn(insertedRequests);
    }
  } catch (err) {
    // Trace the failure on the work item event log; don't rethrow (submission is durable).
    await emitEvent(supabase, { kind: 'build_started', workItemId: workItem.id, detail: { error: err.message } });
    console.error('[devPipeline] dispatch failed for work item', workItem.id, ':', err.message);
  }

  if (dispatchedRequestId) {
    await emitEvent(supabase, { kind: 'build_started', workItemId: workItem.id, detail: { requestId: dispatchedRequestId } });
  }

  // ── Step 5: repetition marker ─────────────────────────────────────────────
  await handleRepetition(supabase, subsystem);

  return { isDuplicate: false, workItem };
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

      if (supabase) {
        const triage = await processSubmission(supabase, anthropic, {
          source: 'dev_mode',
          rawText: text,
          sessionId: null,
          insertedRequests: rows,
          dispatchFn: rows.length > 0 ? async () => rows[0].id : null,
        });
        if (triage.isDuplicate) {
          return json(200, { requests: rows.map(publicRow), duplicate: true, attachedTo: triage.existingWorkItem });
        }
      }

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
    // Failures arriving from the workflows get classified the same way as a
    // dispatch failure, so CI/deploy flakes are retryable and scope-fence or
    // destructive-migration blocks stay terminal.
    if (patch.status === 'failed' || patch.status === 'needs_attention') {
      await applyFailure(supabase, requestId, patch, `gh:${event}`, event);
    } else {
      await setStatus(supabase, requestId, patch, `gh:${event}`);
      if (event === 'deployed') {
        const { data: cur } = await supabase
          .from('dev_build_requests').select('failure_signature').eq('id', requestId).single();
        await resolveAlert(supabase, cur?.failure_signature);
      }
    }
    return json(200, { ok: true });
  }

  // POST /dev/release/start | /dev/release/complete — build-train callbacks
  // from mobile-release.yml. Authed with the same status token as the other
  // workflow callbacks (these are workflow → backend, not app → backend).
  //
  // Both are idempotent on run_id, and `complete` re-derives the batch rather
  // than trusting that `start` landed: the whole point of this design is that a
  // dropped callback costs latency, never correctness.
  if (req.method === 'POST' && (path === '/dev/release/start' || path === '/dev/release/complete')) {
    if (!checkStatusToken(req)) return json(401, { error: 'unauthorized' });
    if (!supabase) return json(503, { error: 'database not configured' });
    const body = await readBody(req);
    const payload = {
      runId: body.run_id,
      runNumber: body.run_number ?? null,
      commitSha: body.commit_sha,
      expediteRequestId: body.expedite_request_id || null,
      status: body.status,
      error: body.error,
    };
    if (!payload.runId || !payload.commitSha) {
      return json(400, { error: 'run_id and commit_sha required' });
    }
    try {
      const release = path === '/dev/release/start'
        ? await startRelease(supabase, payload)
        : await completeRelease(supabase, payload);
      return json(200, { ok: true, release });
    } catch (err) {
      console.error('[devPipeline] release callback failed:', err.message);
      return json(502, { error: err.message });
    }
  }

  // PATCH /dev/requests/:id/archive — mark a request as archived (non-destructive).
  if (req.method === 'PATCH' && path.startsWith('/dev/requests/') && path.endsWith('/archive')) {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    if (!supabase) return json(404, { error: 'not found' });
    const id = decodeURIComponent(path.slice('/dev/requests/'.length, -'/archive'.length));
    const { error: patchErr } = await supabase
      .from('dev_build_requests')
      .update({ archived: true, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (patchErr) return json(500, { error: patchErr.message });
    return json(200, { ok: true });
  }

  // POST /dev/requests/:id/resubmit — human "try again" for a stuck request.
  // The auto-retry loop deliberately refuses terminal failures (scope fence,
  // destructive migration); this is the escape hatch for when the underlying
  // cause has been fixed by hand.
  if (req.method === 'POST' && path.startsWith('/dev/requests/') && path.endsWith('/resubmit')) {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    if (!supabase) return json(404, { error: 'not found' });
    const id = decodeURIComponent(path.slice('/dev/requests/'.length, -'/resubmit'.length));

    const { data: row } = await supabase.from('dev_build_requests').select('*').eq('id', id).single();
    if (!row) return json(404, { error: 'not found' });
    if (!RESUBMITTABLE.includes(row.status)) {
      return json(409, { error: `cannot resubmit a request that is ${row.status}` });
    }

    const plan = resubmitPlan(row);
    try {
      if (plan === 'rerun_deploy') await rerunDeploy(row);
      else await dispatchBuild(row);

      // A human resubmitting is asserting the underlying fault is fixed, so
      // the breaker for this signature reopens the road for its siblings too.
      await resolveAlert(supabase, row.failure_signature);
      await setStatus(
        supabase,
        id,
        {
          status: plan === 'rerun_deploy' ? 'deploying' : 'building',
          attempts: (row.attempts ?? 0) + 1,
          next_retry_at: null,
          error: null,
        },
        `manual resubmit (${plan})`,
      );
      const { data: updatedRow } = await supabase
        .from('dev_build_requests')
        .select('*')
        .eq('id', id)
        .single();
      return json(200, { ok: true, plan, item: updatedRow ?? null });
    } catch (err) {
      await applyFailure(
        supabase,
        id,
        { status: 'failed', error: String(err.message).slice(0, 300) },
        'manual resubmit failed',
        'resubmit',
      );
      return json(502, { error: err.message });
    }
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

// ─── POST /api/dev-items — agent-callable shortcut to create a pipeline task ──
//
// The voice agent's create_dev_item tool POSTs here when dev mode is active.
// Maps the simplified (type, title, description, priority) payload into a
// dev_build_requests row so it appears in the existing Dev tab backlog.

export async function handleDevItems(req, res, deps) {
  const { CORS, checkClientToken, supabase } = deps;

  const json = (status, obj) => {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') return json(204, {});
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(400, { error: 'invalid JSON' });
  }

  const { type, title, description, priority = 'normal', userId, sessionId } = body;

  const VALID_TYPES = ['bug', 'feature', 'task'];
  const VALID_PRIORITIES = ['low', 'normal', 'high'];

  if (!type || !VALID_TYPES.includes(type)) return json(400, { error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  if (!title || typeof title !== 'string' || !title.trim()) return json(400, { error: 'title is required' });
  if (!description || typeof description !== 'string' || !description.trim()) return json(400, { error: 'description is required' });
  if (!VALID_PRIORITIES.includes(priority)) return json(400, { error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });

  if (!supabase) return json(503, { error: 'database not configured' });

  const target = type === 'bug' ? 'backend' : 'agent';
  const confidence = priority === 'high' ? 0.9 : priority === 'low' ? 0.65 : 0.75;

  const row = {
    source: 'agent_tool',
    user_id: userId ? String(userId) : null,
    session_id: sessionId || null,
    title: String(title).trim().slice(0, 200),
    target,
    description: String(description).trim() || null,
    confidence,
    spec: {
      acceptanceCriteria: [],
      affectedFiles: [],
      claudeCodePrompt: String(description).trim(),
    },
    dedupe_key: dedupeKey(target, title),
    status: 'pending',
    history: [{ at: new Date().toISOString(), to: 'created', note: `agent_tool:${type}:priority=${priority}` }],
  };

  const { data, error } = await supabase.from('dev_build_requests').insert([row]).select('id, title, status').single();
  if (error) {
    console.error('[devItems] insert failed:', error.message);
    return json(500, { error: error.message });
  }

  console.log(`[devItems] created ${type} "${data.title}" id=${data.id} priority=${priority}`);
  return json(201, { id: data.id, title: data.title, status: data.status });
}
