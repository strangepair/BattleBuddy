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
import { reconcileStatus } from './devReconcile.js';

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

// Words that carry no signal about WHAT is being asked for. Dropping them stops
// phrasing ("the", "a view of") from diluting the comparison.
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'with',
  'from', 'is', 'be', 'as', 'by', 's', 'it', 'its', 'this', 'that',
]);

const NEAR_DUPLICATE_THRESHOLD = Number(process.env.DEV_NEAR_DUPLICATE_THRESHOLD || 0.6);

function titleTokens(title) {
  const out = new Set();
  for (const w of normalizeWords(String(title || ''))) {
    if (TITLE_STOPWORDS.has(w) || w.length < 2) continue;
    // Crude singularisation so "logs" and "log" are the same ask.
    out.add(w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

/**
 * How much two request titles describe the same ask, 0..1.
 *
 * Overlap coefficient (intersection over the SMALLER set), not Jaccard. Jaccard
 * punishes a longer title for its extra words, so "Calendar: show only
 * current-day logs; enable full scroll" and "Calendar view: show only current
 * day's logged activities" scored 0.43 and both landed as separate rows — one of
 * the real duplicate pairs sitting in the backlog. Containment is the right
 * question here: does one title's meaning fit inside the other's?
 */
export function titleSimilarity(a, b) {
  const x = titleTokens(a);
  const y = titleTokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size);
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

  // Near-duplicate collapse against what is already OPEN, not just an exact
  // dedupe_key match. The key is a hash of (target|normalised title), so three
  // rewordings of one ask — "Calendar: show only current-day logs", "Calendar
  // view: show only current day's logged activities", "Calendar: show only
  // current-day logs; make timeline scrollable" — hash differently and all three
  // landed as separate rows. That is what filled the backlog with duplicates.
  //
  // Wrapped: this is an ENHANCEMENT to insertion, so it must never be able to
  // prevent one. Durability-first — a submission that cannot be deduped is
  // still a submission, and losing it would be far worse than a duplicate.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  let openRows = [];
  try {
    const { data } = await supabase
      .from('dev_build_requests')
      .select('title, target, status')
      .gte('created_at', sevenDaysAgo)
      .in('status', ['pending', 'building', 'in_review', 'merging', 'deploying', 'needs_attention']);
    openRows = data || [];
  } catch (err) {
    console.error('[devPipeline] near-duplicate scan unavailable, inserting anyway:', err.message);
  }

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

  function nearDuplicateOf(task) {
    for (const r of openRows || []) {
      if (r.target !== task.target) continue;
      if (titleSimilarity(task.title, r.title) >= NEAR_DUPLICATE_THRESHOLD) return r;
    }
    return null;
  }

  const rows = tasks
    .filter((t) => !seen.has(dedupeKey(t.target, t.title)))
    .filter((t) => {
      const dup = nearDuplicateOf(t);
      if (dup) console.log('[devPipeline] skip insert: near-duplicate of open row:', dup.title);
      return !dup;
    })
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

/**
 * Record a directive the spec generator could not turn into anything.
 *
 * generateProductRequests returns [] when the model truncated or its JSON did
 * not parse. The endpoint used to answer 200 {"requests":[]} — no row, no error,
 * nothing on screen — so the submission simply vanished. Durability-first says a
 * submission must never disappear silently; this is the visible landing place,
 * with the original text preserved so it can be re-run by hand.
 */
export async function parkUnprocessedDirective(supabase, { userId }, text, reason) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('dev_build_requests')
    .insert({
      source: 'directive',
      user_id: userId ? String(userId) : null,
      title: text.slice(0, 120),
      target: 'backend',
      description: text.slice(0, 4000),
      spec: { rawDirective: text, unprocessed: true, reason },
      confidence: 0,
      dedupe_key: dedupeKey('backend', text),
      status: 'needs_attention',
      error: `Could not be turned into a build request (${reason}). The original wording is kept in spec.rawDirective — resubmit or reword it.`,
      history: [{ at: new Date().toISOString(), to: 'needs_attention', note: `unprocessed directive parked (${reason})` }],
    })
    .select('*')
    .single();
  if (error) {
    console.error('[devPipeline] DURABILITY: could not park unprocessed directive:', error.message);
    return null;
  }
  console.warn('[devPipeline] parked unprocessed directive as', data.id);
  return data;
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
    reconciled_at: r.reconciled_at ?? null,
    // Stage clock (migration 023): when this row took its current state, and
    // whether a stage timeout is what retired it.
    entered_at: r.entered_at ?? null,
    timed_out_at: r.timed_out_at ?? null,
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
  const at = new Date().toISOString();
  history.push({ at, from: cur?.status, to: patch.status, note: note || null });
  await supabase
    .from('dev_build_requests')
    .update({
      ...patch,
      // `entered_at` is when the row took its CURRENT state — the clock the
      // stage-timeout sweep reads. updated_at cannot serve: any unrelated write
      // (a reconciler touch, an archive) would reset the stage's TTL.
      ...(patch.status && patch.status !== cur?.status ? { entered_at: at } : {}),
      updated_at: at,
      history,
    })
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
//
// WHY THIS TICK IS INSTRUMENTED
//
// 2026-08-05: 29 rows sat `pending` for hours while the dispatcher looked dead.
// It was not dead — it was refusing, correctly, because eleven rows were parked
// in `merging`/`deploying` whose PRs had merged days earlier and whose terminal
// callbacks never arrived. Every concurrency slot was held by a ghost. From
// outside the container that is indistinguishable from a dead interval: no
// route reported the gate values, no route reported the last tick, and there is
// no log access. Diagnosis took hours of inference from row timestamps.
//
// So the tick now records WHY it did nothing, every time, and serves it at
// GET /dev/worker/status. Three classes of silent stall are closed here:
//
//   1. a swallowed query error (`{ data }` destructured, `error` dropped) —
//      a failing select read as an empty queue, forever;
//   2. head-of-line starvation — `.limit(slots)` ran BEFORE the archived rows
//      were filtered out, so with DEV_MAX_CONCURRENT=1 a single archived-but-
//      pending row at the head of the queue starved every row behind it;
//   3. overlapping ticks — no re-entrancy guard, so a dispatch slower than the
//      60s interval let two ticks select and dispatch the same row twice.

// A tick that has not finished within this window is treated as hung: the next
// tick abandons it rather than deferring to it forever. Generous — a normal
// tick is a handful of Supabase reads and at most `slots` GitHub dispatches.
const TICK_TIMEOUT_MS = Number(process.env.DEV_WORKER_TICK_TIMEOUT_MS || 5 * 60 * 1000);

// In-flight = still in GitHub's hands, and counted against DEV_MAX_CONCURRENT.
// One list, exported, so the worker, the status route and (stage 3) the stage
// timeout sweep can never disagree about what "occupies a slot" means.
export const INFLIGHT_STATUSES = ['building', 'in_review', 'merging', 'deploying'];

// ─── Stage timeouts (migration 023) ──────────────────────────────────────────
//
// No state may be permanent. Every in-flight state is a claim that GitHub still
// owes us a transition, and every one of those claims can be lost: a callback
// that 404s, an Actions run that is cancelled, an auto-merge that silently
// disarms on a conflict, a release that never goes live. PR #124 sat in
// `merging` and held the only slot until a human noticed; eleven rows did the
// same thing on 2026-08-05 and cost the queue an afternoon.
//
// The reconciler repairs those from GitHub — when it is running, when GitHub
// answers, and when GitHub actually knows. This is the backstop for when none
// of that holds: past its stage's TTL a row is retired to `needs_attention`
// with the reason written into it, and the slot comes back. Losing a slot to a
// ghost is unrecoverable; retiring a row a human can resubmit is not.
const STAGE_TTL_MINUTES = {
  // Autobuild: Claude Code implements, pushes, opens the PR. The reconciler's
  // own orphan check (no branch, no PR after 30m) usually gets here first.
  building: Number(process.env.DEV_TTL_BUILDING_MIN || 45),
  // Open PR waiting on CI, including a rerun after a flake.
  in_review: Number(process.env.DEV_TTL_IN_REVIEW_MIN || 120),
  // Green and waiting on auto-merge. Strict branch protection serialises
  // merges, so this is generous — but a disarmed auto-merge waits forever.
  merging: Number(process.env.DEV_TTL_MERGING_MIN || 90),
  // Server deploy is minutes; a mobile change waits on an EAS build train.
  deploying: Number(process.env.DEV_TTL_DEPLOYING_MIN || 180),
};

// Rows that were never built and never will be do not spend build budget.
// Counting them (the old `neq('needs_attention')` did) let a burst of parked
// duplicates silently exhaust DEV_MAX_PER_DAY and stall the queue for a day.
const NON_SPENDING_STATUSES = ['needs_attention', 'superseded', 'duplicate'];

const heartbeat = {
  bootedAt: new Date().toISOString(),
  ticks: 0,
  running: false,
  lastTickStartedAt: null,
  lastTickFinishedAt: null,
  lastTickMs: null,
  lastDispatchAt: null,
  lastDispatchedId: null,
  dispatchedTotal: 0,
  skipReason: null,
  lastError: null,
  consecutiveErrors: 0,
  abandonedTicks: 0,
  retiredTotal: 0,
  lastSweep: null,
  watchdogFirings: 0,
  lastWatchdog: null,
  gates: {},
  inflightRows: [],
};

/**
 * Retire rows that have outstayed their stage, freeing the slots they hold.
 *
 * Exported for the watchdog and for tests. Idempotent: a row is retired once,
 * because `needs_attention` is not an in-flight state and is never re-scanned.
 */
export async function sweepStageTimeouts(supabase, now = Date.now()) {
  if (!supabase) return { retired: 0, rows: [] };

  const { data, error } = await supabase
    .from('dev_build_requests')
    .select('id, title, status, pr_number, entered_at, updated_at, created_at')
    .in('status', INFLIGHT_STATUSES)
    .limit(100);
  if (error) throw new Error(`stage timeout scan failed: ${error.message}`);

  const retired = [];
  for (const row of data || []) {
    const ttl = STAGE_TTL_MINUTES[row.status];
    if (!ttl) continue;
    // entered_at is when this row took its CURRENT state. Rows that predate
    // migration 023 fall back to updated_at, which is the same thing for every
    // transition the pipeline has ever written.
    const since = new Date(row.entered_at || row.updated_at || row.created_at || now).getTime();
    if (!Number.isFinite(since)) continue;
    const heldFor = Math.round((now - since) / 60000);
    if (heldFor <= ttl) continue;

    const reason = `stage timeout: held ${heldFor}m in ${row.status} (limit ${ttl}m) — `
      + (row.pr_number
        ? `PR #${row.pr_number} never reported a terminal state`
        : 'no PR ever appeared')
      + '. Slot released; resubmit when the cause is understood.';

    await setStatus(supabase, row.id, {
      status: 'needs_attention',
      error: reason.slice(0, 300),
      timed_out_at: new Date(now).toISOString(),
      // Terminal by class: a stage timeout means something outside this process
      // stopped answering. Auto-retrying that burns build minutes on a fault the
      // pipeline cannot see.
      failure_class: 'terminal',
      next_retry_at: null,
    }, reason);

    // ONE visible alert per stuck row, collapsed by the partial unique index.
    const { error: alertErr } = await supabase.from('pipeline_alerts').insert({
      kind: 'stage_timeout',
      signature: `stage_timeout:${row.id}`,
      detail: { request_id: row.id, status: row.status, held_minutes: heldFor, ttl_minutes: ttl, pr_number: row.pr_number ?? null },
    });
    if (alertErr && !/duplicate key/i.test(alertErr.message)) {
      console.error('[devPipeline] stage timeout alert failed:', alertErr.message);
    }
    console.warn(`[devPipeline] retired ${String(row.id).slice(0, 8)}: ${reason}`);
    retired.push({ id: row.id, status: row.status, heldFor, ttl });
  }

  return { retired: retired.length, rows: retired };
}

/**
 * Everything needed to answer "is the dispatcher working, and if not, why not?"
 * from outside the container. Served by GET /dev/worker/status.
 */
export function workerStatus() {
  const last = heartbeat.lastTickFinishedAt || heartbeat.lastTickStartedAt;
  return {
    ...heartbeat,
    enabled: isPipelineEnabled(),
    paused: PAUSED,
    dryRun: isDryRun(),
    maxConcurrent: MAX_CONCURRENT,
    maxPerDay: MAX_PER_DAY,
    secondsSinceLastTick: last ? Math.round((Date.now() - new Date(last).getTime()) / 1000) : null,
    // The one number that matters: a free slot with a full queue and nothing
    // dispatched is the failure this pipeline keeps having.
    starved: Boolean(
      heartbeat.gates.pending > 0
      && (heartbeat.gates.inflight ?? 0) < MAX_CONCURRENT
      && heartbeat.gates.dispatched === 0
      && !['paused', 'disabled', 'daily_cap'].includes(heartbeat.skipReason),
    ),
  };
}

// ─── Watchdog ────────────────────────────────────────────────────────────────
//
// The heartbeat above makes a stall LEGIBLE. This makes it self-correcting.
//
// Three ways the dispatcher goes quiet, all observed or one bad await away:
//
//   1. no tick at all — the interval stopped firing, or a tick is hung on an
//      await that never settles (fetch with no timeout is the realistic case);
//   2. ticking but starved — pending > 0, a free slot, nothing dispatched. This
//      is exactly 2026-08-05, and the shape any future gate bug will take;
//   3. ticking into an error every time — the tick throws before dispatch.
//
// On any of them: raise ONE visible alert, restart the timer, and force a tick.
// The alert closes itself when the pipeline recovers, so an open `worker_stall`
// row always means "right now", never "once, in August".
const WATCHDOG_STALE_MS = Number(process.env.DEV_WATCHDOG_STALE_MS || 4 * 60 * 1000);
// A single starved tick is not a stall — a row can be inserted a millisecond
// after the queue was read. Two consecutive minutes of it is.
const WATCHDOG_STARVED_MS = Number(process.env.DEV_WATCHDOG_STARVED_MS || 2 * 60 * 1000);
const WATCHDOG_SIGNATURE = 'worker_stall';

let starvedSince = null;

export async function runWorkerWatchdog(deps = {}) {
  const { supabase, kick, restartTimer, status = workerStatus, now = Date.now() } = deps;
  const st = status();

  const reasons = [];

  // 1. Is it ticking at all?
  const lastTickMs = st.lastTickFinishedAt || st.lastTickStartedAt || st.bootedAt;
  const sinceTick = now - new Date(lastTickMs).getTime();
  if (sinceTick > WATCHDOG_STALE_MS) {
    reasons.push(`no completed tick for ${Math.round(sinceTick / 1000)}s`);
  }
  if (st.running && now - new Date(st.lastTickStartedAt || now).getTime() > TICK_TIMEOUT_MS) {
    reasons.push('a tick has been running past its timeout — presumed hung');
  }

  // 2. Ticking, but a free slot and a full queue. The failure this exists for.
  if (st.starved) {
    if (starvedSince === null) starvedSince = now;
    if (now - starvedSince > WATCHDOG_STARVED_MS) {
      reasons.push(
        `${st.gates.pending} pending with ${st.maxConcurrent - (st.gates.inflight ?? 0)} free slot(s) `
        + `and nothing dispatched for ${Math.round((now - starvedSince) / 1000)}s`,
      );
    }
  } else {
    starvedSince = null;
  }

  // 3. Ticking into the same error every time.
  if (st.consecutiveErrors >= 3) {
    reasons.push(`${st.consecutiveErrors} consecutive tick failures: ${st.lastError?.message || 'unknown'}`);
  }

  if (reasons.length === 0) {
    // Recovery closes the alert. An open `worker_stall` must always mean now.
    if (heartbeat.lastWatchdog?.action) {
      heartbeat.lastWatchdog = { ...heartbeat.lastWatchdog, recoveredAt: new Date(now).toISOString() };
      if (supabase) await resolveAlert(supabase, WATCHDOG_SIGNATURE);
    }
    return { healthy: true, reasons: [] };
  }

  heartbeat.watchdogFirings += 1;
  heartbeat.lastWatchdog = {
    at: new Date(now).toISOString(),
    reasons,
    action: 'restarted the tick',
    recoveredAt: null,
  };
  console.error('[devPipeline] watchdog: dispatcher stalled —', reasons.join('; '));

  if (supabase) {
    const { error } = await supabase.from('pipeline_alerts').insert({
      kind: 'worker_stall',
      signature: WATCHDOG_SIGNATURE,
      detail: { reasons, gates: st.gates, inflight_rows: st.inflightRows, firings: heartbeat.watchdogFirings },
    });
    // The partial unique index collapses a continuing stall into one alert.
    if (error && !/duplicate key/i.test(error.message)) {
      console.error('[devPipeline] watchdog alert failed:', error.message);
    }
  }

  // Re-arm the timer first: if the interval itself died, kicking one tick fixes
  // one minute. Then run a tick immediately rather than waiting out the period.
  try { restartTimer?.(); } catch (err) { console.error('[devPipeline] watchdog restart failed:', err.message); }
  try { await kick?.(); } catch (err) { console.error('[devPipeline] watchdog kick failed:', err.message); }

  return { healthy: false, reasons };
}

export async function runDevBuildWorker(deps) {
  const { supabase } = deps;

  // Re-entrancy guard. A tick slower than the interval must not run twice over
  // the same pending row — that dispatches one request as two builds.
  if (heartbeat.running) {
    const startedMs = new Date(heartbeat.lastTickStartedAt || 0).getTime();
    if (Date.now() - startedMs < TICK_TIMEOUT_MS) {
      heartbeat.skipReason = 'previous_tick_still_running';
      return;
    }
    // Past the timeout the previous tick is presumed hung (a fetch that never
    // settles is the realistic case). Abandon it: a hung await must not be able
    // to hold the dispatcher shut forever.
    heartbeat.abandonedTicks += 1;
    console.error('[devPipeline] abandoning a tick that never finished; starting a fresh one');
  }

  heartbeat.running = true;
  heartbeat.ticks += 1;
  heartbeat.lastTickStartedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    await workerTick(supabase);
    heartbeat.lastError = null;
    heartbeat.consecutiveErrors = 0;
  } catch (err) {
    heartbeat.lastError = { at: new Date().toISOString(), message: String(err?.message || err).slice(0, 300) };
    heartbeat.consecutiveErrors += 1;
    heartbeat.skipReason = 'error';
    throw err;                        // index.js logs it; the heartbeat keeps it
  } finally {
    heartbeat.running = false;
    heartbeat.lastTickFinishedAt = new Date().toISOString();
    heartbeat.lastTickMs = Date.now() - t0;
  }
}

async function workerTick(supabase) {
  heartbeat.skipReason = null;
  heartbeat.gates = { dispatched: 0 };

  if (!supabase) { heartbeat.skipReason = 'no_database'; return; }

  // Retire timed-out rows FIRST, so a slot freed by this sweep is filled by the
  // same tick rather than 60 seconds later. Runs even when the pipeline is
  // paused: like the reconciler, repairing state is correct while dispatching
  // is not — and a pause is exactly when ghosts accumulate.
  //
  // FAIL-SOFT, and this is not defensive decoration. deploy.yml deploys the
  // server BEFORE it applies migrations, so between those two jobs the new code
  // is talking to the old schema. The first deploy of this sweep threw
  // `column dev_build_requests.entered_at does not exist` and, because the
  // failure propagated, took the whole tick down with it — the repair wedged
  // the dispatcher it exists to protect. A sweep is a repair, never a
  // precondition: it reports its own failure and the tick carries on.
  try {
    const swept = await sweepStageTimeouts(supabase);
    heartbeat.lastSweep = { at: new Date().toISOString(), retired: swept.retired, error: null };
    if (swept.retired) heartbeat.retiredTotal += swept.retired;
  } catch (err) {
    heartbeat.lastSweep = { at: new Date().toISOString(), retired: 0, error: String(err.message).slice(0, 200) };
    console.error('[devPipeline] stage timeout sweep failed (dispatch continues):', err.message);
  }

  if (!isPipelineEnabled()) { heartbeat.skipReason = PAUSED ? 'paused' : 'disabled'; return; }

  // ── Gates ─────────────────────────────────────────────────────────────────
  // Read the in-flight rows themselves, not just a count. When the queue is
  // blocked, "which rows are holding the slots and for how long" is the entire
  // answer — a bare number sent the last investigation down a dead end.
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [inflightRes, todayRes, pendingCountRes] = await Promise.all([
    supabase.from('dev_build_requests')
      .select('id, title, status, pr_number, entered_at, updated_at')
      .in('status', INFLIGHT_STATUSES)
      .order('updated_at', { ascending: true })
      .limit(50),
    supabase.from('dev_build_requests').select('*', { count: 'exact', head: true })
      .gte('created_at', dayAgo)
      .not('status', 'in', `(${NON_SPENDING_STATUSES.join(',')})`),
    supabase.from('dev_build_requests').select('*', { count: 'exact', head: true })
      .eq('status', 'pending').eq('archived', false),
  ]);
  // An error here used to be indistinguishable from an empty queue. Never again:
  // it fails the tick loudly and lands in the heartbeat.
  for (const [what, res] of [['inflight', inflightRes], ['daily rate', todayRes], ['pending count', pendingCountRes]]) {
    if (res?.error) throw new Error(`${what} query failed: ${res.error.message}`);
  }

  const inflightRows = inflightRes.data || [];
  const inflight = inflightRows.length;
  const today = todayRes.count || 0;
  const pendingCount = pendingCountRes.count || 0;

  heartbeat.inflightRows = inflightRows.map((r) => ({
    id: r.id,
    status: r.status,
    pr_number: r.pr_number ?? null,
    title: (r.title || '').slice(0, 80),
    heldForMinutes: (r.entered_at || r.updated_at)
      ? Math.round((Date.now() - new Date(r.entered_at || r.updated_at).getTime()) / 60000)
      : null,
    ttlMinutes: STAGE_TTL_MINUTES[r.status] ?? null,
  }));
  heartbeat.gates = { inflight, today, pending: pendingCount, slots: 0, dispatched: 0 };

  if (inflight >= MAX_CONCURRENT) { heartbeat.skipReason = 'at_capacity'; return; }
  if (today >= MAX_PER_DAY) { heartbeat.skipReason = 'daily_cap'; return; }

  const slots = MAX_CONCURRENT - inflight;
  heartbeat.gates.slots = slots;

  // An archived row is one a human took off the board. It can still be
  // `pending` — and the filter used to be applied AFTER `.limit(slots)`, so one
  // archived row at the head of a FIFO queue with a single slot starved
  // everything behind it forever. Filter in the query: the limit then applies
  // to rows that are actually dispatchable.
  const { data: pending, error: pendingErr } = await supabase
    .from('dev_build_requests')
    .select('*')
    .eq('status', 'pending')
    .eq('archived', false)
    .order('created_at', { ascending: true })
    .limit(slots);
  if (pendingErr) throw new Error(`pending select failed: ${pendingErr.message}`);

  for (const req of pending || []) {
    await attemptDispatch(supabase, req, 'dispatched to GitHub Actions');
  }
  if (!pending?.length && pendingCount === 0) heartbeat.skipReason = 'queue_empty';

  // ── Retry pass ────────────────────────────────────────────────────────────
  // Re-pick failed rows whose class is retryable and whose backoff has expired.
  // A row only reaches here if applyFailure set next_retry_at, which it does
  // only for transient / stale_branch under the per-class cap and only while
  // the breaker for its signature is closed. Both classes re-dispatch: autobuild
  // branches from current main, so a regenerated build resolves a stale-branch
  // conflict by construction.
  const retrySlots = slots - (pending || []).length;
  if (retrySlots <= 0) return;

  const { data: dueRetries, error: retryErr } = await supabase
    .from('dev_build_requests')
    .select('*')
    .eq('status', 'failed')
    .in('failure_class', ['transient', 'stale_branch'])
    .not('next_retry_at', 'is', null)
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(retrySlots);
  if (retryErr) throw new Error(`retry select failed: ${retryErr.message}`);

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
    // Recorded here rather than at the call sites so the retry pass counts too:
    // "last dispatch" is the number the watchdog and the status route trust.
    heartbeat.dispatchedTotal += 1;
    heartbeat.gates.dispatched = (heartbeat.gates.dispatched || 0) + 1;
    heartbeat.lastDispatchAt = new Date().toISOString();
    heartbeat.lastDispatchedId = req.id;
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
      const userId = resolveUserId ? resolveUserId(body.userId) : body.userId;
      const rows = await insertRequests(supabase, { source: 'directive', userId, sessionId: null }, tasks);

      // SILENT DROP GUARD — Mike's submissions were vanishing here.
      if (rows.length === 0) {
        if (tasks.length === 0) {
          // The generator produced nothing usable. Park it so it is visible.
          const parked = await parkUnprocessedDirective(supabase, { userId }, text, 'spec generation returned nothing');
          return json(422, {
            error: 'That could not be turned into a build request. It has been saved for review, not lost.',
            reason: 'generation_empty',
            requests: parked ? [publicRow(parked)] : [],
          });
        }
        // Tasks existed but every one collapsed onto something already open.
        // Not a failure, but the app must say so rather than show nothing.
        return json(200, {
          requests: [],
          deduped: true,
          message: 'Everything in that directive is already tracked — no new work was created.',
        });
      }

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
    if (!supabase) return json(200, { total: 0, data: [], requests: [] });
    // Filterable: the flat newest-100 window hid in-flight rows behind a wall of
    // backlog, which is exactly how a slot-holding row stays invisible.
    const statusFilter = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
    const statusValues = statusFilter ? statusFilter.split(',').map((s) => s.trim()).filter(Boolean) : null;
    let countQ = supabase.from('dev_build_requests').select('*', { count: 'exact', head: true });
    if (statusValues) countQ = countQ.in('status', statusValues);
    let q = supabase.from('dev_build_requests').select('*');
    if (statusValues) q = q.in('status', statusValues);
    const [{ count }, { data }] = await Promise.all([countQ, q.order('created_at', { ascending: false }).limit(limit)]);
    const rows = (data || []).map(publicRow);
    return json(200, { total: count ?? rows.length, data: rows, requests: rows, enabled: isPipelineEnabled(), dryRun: isDryRun() });
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

  // POST /dev/requests/:id/cancel — terminal, non-destructive stop.
  // Archiving alone was not enough: `archived` is a display flag, so an archived
  // row kept status `pending` and runDevBuildWorker would still dispatch it.
  // Cancelling parks it in `superseded` (terminal) AND archives it.
  if (req.method === 'POST' && path.startsWith('/dev/requests/') && path.endsWith('/cancel')) {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    if (!supabase) return json(404, { error: 'not found' });
    const id = decodeURIComponent(path.slice('/dev/requests/'.length, -'/cancel'.length));
    const { data: row } = await supabase.from('dev_build_requests').select('*').eq('id', id).single();
    if (!row) return json(404, { error: 'not found' });
    if (['deployed', 'superseded'].includes(row.status)) {
      return json(409, { error: `cannot cancel a request that is ${row.status}` });
    }
    await setStatus(supabase, id, { status: 'superseded', archived: true, next_retry_at: null }, 'cancelled by operator');
    return json(200, { ok: true, id });
  }

  // POST /dev/backlog/clear — cancel the whole queued backlog at once.
  // Body: { status?: 'pending', dryRun?: boolean, keep?: [id, ...] }.
  // Returns the rows it cancelled so nothing is lost silently — the caller can
  // see exactly what went, and re-queue anything that mattered.
  if (req.method === 'POST' && path === '/dev/backlog/clear') {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    if (!supabase) return json(503, { error: 'database not configured' });
    const body = await readBody(req);
    const targetStatus = body.status || 'pending';
    const keep = new Set(body.keep || []);

    const { data: rows, error: selErr } = await supabase
      .from('dev_build_requests')
      .select('*')
      .eq('status', targetStatus)
      .order('created_at', { ascending: true });
    if (selErr) return json(500, { error: selErr.message });

    const doomed = (rows || []).filter((r) => !keep.has(r.id));
    if (body.dryRun) {
      return json(200, { dryRun: true, wouldCancel: doomed.map(publicRow), kept: [...keep] });
    }
    for (const r of doomed) {
      await setStatus(supabase, r.id, { status: 'superseded', archived: true, next_retry_at: null }, 'backlog cleared');
    }
    return json(200, { ok: true, cancelled: doomed.map(publicRow), kept: [...keep] });
  }

  // GET /dev/worker/status — is the DISPATCHER alive, and if it dispatched
  // nothing, why not? The reconciler got this route after it stalled silently;
  // the worker then stalled silently in exactly the same way, with a full queue
  // and a free slot, and cost hours of guesswork. Symmetry is the fix.
  if (req.method === 'GET' && path === '/dev/worker/status') {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    return json(200, workerStatus());
  }

  // GET /dev/reconcile/status — is the reconciler alive and making progress?
  // The first version stalled silently for hours and was undiagnosable from
  // outside the container. Never again.
  if (req.method === 'GET' && path === '/dev/reconcile/status') {
    if (!checkClientToken(req)) return json(401, { error: 'unauthorized' });
    return json(200, reconcileStatus());
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
