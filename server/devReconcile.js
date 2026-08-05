// devReconcile.js — GitHub is the source of truth; the database is a projection.
//
// WHY THIS EXISTS
//
// Every status callback in deploy.yml, ci.yml and autobuild.yml is
// `curl -sf ... || true`. A transient failure silently drops that transition
// FOREVER — nothing retries, nothing notices. Worse, a transition only exists at
// all if some workflow posts one, so a cancelled run, a superseded pending run,
// a crashed agent or a hand-made PR posts nothing whatsoever.
//
// Push-only delivery + best-effort + no reconciler = guaranteed drift. That is
// what made a shipped change read "in flight" 16 hours after it landed, and
// merged rows read failed. Correctness must never depend on delivery.
//
// So this tick asks GitHub what is true and patches the difference. It is
// stateless: it re-derives everything from scratch every time, which means it
// repairs rows that drifted before it existed, rows that drift while it is
// down, and rows nobody ever told it about.
//
// ONE derivation. `deriveState()` is pure and is the ONLY place a status is
// decided. Stage 6's webhooks call the same function with the same shape, so a
// webhook and a tick can never disagree about the same PR.

import { githubJson, rateLimitRemaining } from './githubApi.js';
import { upsertChangeForRequest } from './devRelease.js';

// Last tick's outcome, served by GET /dev/reconcile/status. The first version of
// this module stalled silently for hours and could not be diagnosed from outside
// the container at all — no Railway log access, no route, nothing. Reconciler
// health has to be observable or it is not operable.
let lastTick = { at: null, checked: 0, patched: 0, adopted: 0, error: null, skipped: null };
export function reconcileStatus() {
  return { ...lastTick, rate_limit_remaining: rateLimitRemaining() };
}

// A merged PR's file list never changes, so this is safe to keep for the life of
// the process. It also matters: re-listing files for every merged row on every
// tick was most of this module's GitHub traffic.
const mobileCache = new Map();
let trainEpochCache;

// Rows in these states are still in GitHub's hands. `duplicate` and `deployed`
// are terminal and are left alone; re-deriving them every minute would cost
// calls to change nothing.
export const RECONCILABLE = [
  'pending', 'building', 'in_review', 'merging', 'deploying', 'failed', 'needs_attention',
];

const BATCH = Number(process.env.DEV_RECONCILE_BATCH || 25);
// A dispatched build that never produced a branch or PR within this window did
// not survive its Actions run (agent crash, infra error, dispatch accepted but
// the workflow never started). Autobuild's own crash-net covers the cases where
// the runner lived long enough to curl; this covers the ones where it did not.
const ORPHAN_MS = Number(process.env.DEV_ORPHAN_MINUTES || 30) * 60 * 1000;
// Only PRs touched within this window are adopted, so the first tick does not
// import the entire history of the repository.
const ADOPT_WINDOW_MS = Number(process.env.DEV_ADOPT_WINDOW_DAYS || 14) * 24 * 3600 * 1000;
const ADOPT_PER_TICK = Number(process.env.DEV_ADOPT_PER_TICK || 5);
// GitHub gives a PAT 5,000 REST calls an hour. Stop well short so the pipeline's
// own dispatch and callback traffic is never starved by bookkeeping.
const RATE_FLOOR = Number(process.env.DEV_RECONCILE_RATE_FLOOR || 500);

const UUID_RE = /^auto\/dev-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const TRAILER_RE = /^Dev-Request-Id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;

/**
 * Kill switch, not an opt-in. The reconciler is the correctness backbone: it
 * has to run without anyone remembering to switch it on, so it defaults to
 * enabled wherever it has what it needs (a database and a GitHub token) and
 * DEV_RECONCILE_ENABLED=false is how you stop it.
 */
export function isReconcileEnabled() {
  const v = process.env.DEV_RECONCILE_ENABLED;
  if (v === 'false' || v === '0') return false;
  return Boolean(process.env.GITHUB_TOKEN);
}

// ─── Mapping a PR to the request it implements ───────────────────────────────

/**
 * Request id for a PR, or null.
 *
 * Branch name first (`auto/dev-<uuid>` is written by autobuild.yml), then the
 * `Dev-Request-Id` commit trailer. Both are STATELESS: nothing is remembered
 * between ticks, so a row whose link was lost and a PR nobody recorded both
 * re-link from scratch on the next pass.
 */
export function requestIdForPr(pr, commitMessages) {
  const branch = pr?.head?.ref || '';
  const m = branch.match(UUID_RE);
  if (m) return m[1].toLowerCase();
  for (const msg of commitMessages || []) {
    const t = String(msg || '').match(TRAILER_RE);
    if (t) return t[1].toLowerCase();
  }
  return null;
}

/** Aggregate a check-run list into running | passed | failed. */
export function checksVerdict(checkRuns) {
  const runs = checkRuns || [];
  if (runs.length === 0) return null;
  let pending = false;
  for (const r of runs) {
    if (r.status !== 'completed') { pending = true; continue; }
    if (['failure', 'timed_out', 'action_required'].includes(r.conclusion)) return 'failed';
  }
  return pending ? 'running' : 'passed';
}

// ─── The one derivation ──────────────────────────────────────────────────────

/**
 * Derive the true state of one request from what GitHub says.
 *
 * Pure: no IO, no clock beyond the `now` passed in. Returns a patch of the
 * fields that should change, or an empty object when the row already agrees.
 *
 * @param {object}  row            the dev_build_requests row
 * @param {object?} pr             the PR, if one exists
 * @param {string?} checks         running | passed | failed
 * @param {object?} deploy         { status, conclusion } of the Deploy run for the merge commit
 * @param {string?} lastGoodDeploy ISO timestamp of the newest SUCCESSFUL main deploy
 * @param {boolean} touchesMobile  whether the PR changed anything under mobile/
 * @param {object?} release        the release carrying this change, if any
 * @param {string?} trainEpoch     ISO time mobile-release.yml began existing
 * @param {number}  now            epoch ms
 */
export function deriveState(args) {
  const out = deriveStateRaw(args);

  // ARBITRATION with the circuit breaker. `needs_attention` is an escalation the
  // breaker raised after N failures sharing a signature — it carries strictly
  // more information than "CI is red", which is all this module can see. Letting
  // the reconciler downgrade it to `failed` would start a fight: breaker
  // escalates, tick demotes, every 60 seconds, spamming history and hiding the
  // alert. GitHub still wins whenever it says something the breaker cannot know
  // (merged, superseded, green again) — only the failed/needs_attention pair is
  // resolved in the breaker's favour.
  if (args.row?.status === 'needs_attention' && out.status === 'failed') {
    const { status, error, ...rest } = out;
    return rest;
  }
  return out;
}

function deriveStateRaw({ row, pr, checks, deploy, lastGoodDeploy, touchesMobile, release, trainEpoch, now }) {
  const out = {};
  // `null` is a real value here, not "no opinion": clearing a stale `error` is
  // half of what repairing a wrongly-failed row means. Only `undefined` (GitHub
  // did not tell us) is skipped.
  const set = (k, v) => { if (v !== undefined && row[k] !== v) out[k] = v; };

  // ── GitHub knows nothing about this row ───────────────────────────────────
  //
  // PRECEDENCE: local-only states survive only while no PR exists. `pending`
  // (not dispatched yet), `duplicate` (triage parked it) and a scope-fence
  // `needs_attention` are decisions GitHub never saw, so nothing here may
  // overwrite them.
  if (!pr) {
    const age = now - new Date(row.created_at || now).getTime();
    if (row.status === 'building' && !row.branch && !row.pr_number && age > ORPHAN_MS) {
      return {
        status: 'needs_attention',
        error: `no branch or PR appeared within ${Math.round(ORPHAN_MS / 60000)} minutes of dispatch — `
             + 'the Autobuild run never got far enough to push (agent crash or infra error)',
      };
    }
    return {};
  }

  set('pr_number', pr.number);
  set('pr_url', pr.html_url);
  set('branch', pr.head?.ref);

  // ── Open ──────────────────────────────────────────────────────────────────
  if (pr.state === 'open') {
    if (checks) set('checks_status', checks);
    if (checks === 'failed') {
      set('status', 'failed');
      set('error', 'CI failed');
    } else if (checks === 'passed') {
      // Green and waiting on auto-merge.
      set('status', 'merging');
    } else {
      set('status', 'in_review');
    }
    return out;
  }

  // ── Closed, never merged ──────────────────────────────────────────────────
  // Before this state existed such a row sat at whatever it was last told
  // (usually in_review) forever. PR #95 — closed in favour of #96 on the same
  // branch — is the canonical case.
  if (!pr.merged_at) {
    set('status', 'superseded');
    set('error', null);
    return out;
  }

  // ── Merged ────────────────────────────────────────────────────────────────
  set('checks_status', 'passed');

  // deploy.yml deploys main WHOLESALE — `railway up` from a fresh checkout and
  // psql over every migration file. So a LATER successful deploy of main
  // supersedes an earlier failure: the code is live regardless of what the run
  // at the time concluded. This is exactly why four rows read failed for work
  // that had shipped — the old non-idempotent migration failed the deploy job
  // after the real work had already succeeded.
  const mergedAt = new Date(pr.merged_at).getTime();
  const carriedByLaterDeploy = Boolean(lastGoodDeploy) && mergedAt <= new Date(lastGoodDeploy).getTime();

  let serverLive;
  if (carriedByLaterDeploy) serverLive = true;
  else if (!deploy) serverLive = null;                              // no run yet
  else if (deploy.status !== 'completed') serverLive = null;        // still running
  else serverLive = deploy.conclusion === 'success';

  if (serverLive === null) {
    set('status', 'deploying');
    return out;
  }
  if (serverLive === false) {
    set('status', 'failed');
    set('deploy_status', 'failed');
    set('error', 'deploy failed');
    return out;
  }

  // The server side is live. A change that also touches mobile/ is only really
  // shipped once a build train release carries it to TestFlight — saying
  // "deployed" before that is the lie the Dev tab used to tell.
  //
  // But ONLY for changes merged after the train existed. Anything merged before
  // mobile-release.yml landed was built by deploy.yml's own mobile job, and no
  // release will ever carry it — gating those on a release strands them in
  // `deploying` forever, which is the very drift this module exists to remove.
  // PRs #93 and #83 were sitting exactly there.
  const trainOwnsThis = Boolean(trainEpoch) && mergedAt >= new Date(trainEpoch).getTime();
  if (touchesMobile && trainOwnsThis) {
    if (release?.status === 'live') {
      set('status', 'deployed');
      set('deploy_status', 'ok');
      set('error', null);
    } else if (release?.status === 'failed') {
      set('status', 'failed');
      set('deploy_status', 'failed');
      set('error', 'mobile build failed');
    } else {
      set('status', 'deploying');
    }
    return out;
  }

  set('status', 'deployed');
  set('deploy_status', 'ok');
  set('error', null);
  return out;
}

/** Where a work item sits, given the state of the change implementing it. */
export function stageForStatus(status) {
  switch (status) {
    case 'pending': return 'received';
    case 'building': return 'building';
    case 'in_review':
    case 'merging':
    case 'deploying': return 'verifying';
    case 'deployed': return 'live';
    case 'superseded': return 'archived';
    default: return null;      // failed / needs_attention: leave the stage alone
  }
}

/** Change-row status mirroring the request, so the two can never disagree. */
export function changeStatusFor(status) {
  switch (status) {
    case 'building': return 'building';
    case 'in_review': return 'in_review';
    case 'merging': return 'merged';
    case 'deploying': return 'merged';
    case 'deployed': return 'deployed';
    case 'superseded': return 'superseded';
    case 'failed': return 'failed';
    case 'needs_attention': return 'needs_attention';
    default: return 'building';
  }
}

// ─── GitHub reads for one tick ───────────────────────────────────────────────

/**
 * Everything the tick needs, in a handful of calls rather than a handful per
 * row: one page of PRs, one page of Deploy runs.
 */
export async function loadGitHubSnapshot() {
  const [pulls, deployRuns] = await Promise.all([
    githubJson('pulls?state=all&sort=updated&direction=desc&per_page=100'),
    githubJson('actions/workflows/deploy.yml/runs?per_page=100'),
  ]);

  const prsByNumber = new Map();
  const prsByBranch = new Map();
  for (const pr of pulls || []) {
    prsByNumber.set(pr.number, pr);
    if (pr.head?.ref) prsByBranch.set(pr.head.ref, pr);
  }

  const deployBySha = new Map();
  let lastGoodDeploy = null;
  for (const run of deployRuns?.workflow_runs || []) {
    if (!deployBySha.has(run.head_sha)) {
      deployBySha.set(run.head_sha, { status: run.status, conclusion: run.conclusion });
    }
    if (run.conclusion === 'success' && run.head_branch === 'main') {
      const at = run.head_commit?.timestamp || run.updated_at;
      if (at && (!lastGoodDeploy || at > lastGoodDeploy)) lastGoodDeploy = at;
    }
  }

  return { prsByNumber, prsByBranch, deployBySha, lastGoodDeploy, trainEpoch: await loadTrainEpoch() };
}

/**
 * When the build train began to exist — the moment mobile-release.yml appeared.
 *
 * Anything merged before this was built by deploy.yml's own mobile job and must
 * not be gated on a release that will never come. Cached for the life of the
 * process: a workflow's creation time is immutable.
 */
async function loadTrainEpoch() {
  if (trainEpochCache !== undefined) return trainEpochCache;
  try {
    const wf = await githubJson('actions/workflows/mobile-release.yml');
    trainEpochCache = wf?.created_at || null;
  } catch {
    // Workflow absent (or unreadable) means no train, so nothing is gated.
    trainEpochCache = null;
  }
  return trainEpochCache;
}

/** Does this PR change anything the mobile build ships? */
async function prTouchesMobile(prNumber) {
  if (mobileCache.has(prNumber)) return mobileCache.get(prNumber);
  const files = await githubJson(`pulls/${prNumber}/files?per_page=100`);
  const touches = (files || []).some((f) => String(f.filename || '').startsWith('mobile/'));
  // Only cache a real answer. Caching a failure as `false` would permanently
  // mark a mobile change as server-only and ship it early.
  mobileCache.set(prNumber, touches);
  return touches;
}

// ─── Writing the projection ──────────────────────────────────────────────────

async function applyPatch(supabase, row, patch, prevStatus) {
  const history = Array.isArray(row.history) ? row.history : [];
  history.push({
    at: new Date().toISOString(),
    from: prevStatus,
    to: patch.status ?? prevStatus,
    note: 'reconciled from GitHub',
  });
  await supabase
    .from('dev_build_requests')
    .update({ ...patch, history, reconciled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', row.id);
}

/** Every request gets a work item, and the item follows the change along. */
async function syncWorkItem(supabase, row, status) {
  let workItemId = row.work_item_id;
  if (!workItemId) {
    const { data: wi, error } = await supabase
      .from('work_items')
      .insert({
        title: String(row.title || 'untitled change').slice(0, 200),
        interpretation: row.description || null,
        subsystem: 'pipeline',
        stage: stageForStatus(status) || 'building',
      })
      .select('id')
      .single();
    if (error) {
      console.error('[devReconcile] work_item insert failed:', error.message);
      return null;
    }
    workItemId = wi?.id || null;
    if (workItemId) {
      await supabase.from('dev_build_requests').update({ work_item_id: workItemId }).eq('id', row.id);
    }
    return workItemId;
  }

  const stage = stageForStatus(status);
  if (stage) {
    await supabase
      .from('work_items')
      .update({ stage, updated_at: new Date().toISOString() })
      .eq('id', workItemId);
  }
  return workItemId;
}

// ─── Adoption — every change is tracked, however it was made ─────────────────

/**
 * Give a PR nobody submitted through the app a dev_build_requests row.
 *
 * Mike's rule is that every change is tracked in dev_build_requests, and a
 * direct PR (a hand edit, an agent-authored branch, the PRs shipping this very
 * submission) has no intake path. Adoption is that path: the reconciler simply
 * notices a PR it cannot account for and records it.
 */
export async function adoptPr(supabase, pr, requestId) {
  const row = {
    source: 'github',
    title: String(pr.title || `PR #${pr.number}`).slice(0, 200),
    target: guessTarget(pr),
    description: (pr.body || '').slice(0, 2000) || null,
    spec: { adopted_from_pr: pr.number, acceptanceCriteria: [], affectedFiles: [] },
    status: 'in_review',
    branch: pr.head?.ref || null,
    pr_number: pr.number,
    pr_url: pr.html_url,
    created_at: pr.created_at,
    history: [{ at: new Date().toISOString(), to: 'adopted', note: `adopted from PR #${pr.number}` }],
  };
  // An `auto/dev-<uuid>` branch names the id its row SHOULD have had; reusing it
  // keeps trailers, callbacks and this row pointing at the same thing.
  if (requestId) row.id = requestId;

  const { data, error } = await supabase.from('dev_build_requests').insert(row).select('*').single();
  if (error) {
    console.error('[devReconcile] adopt failed for PR', pr.number, ':', error.message);
    return null;
  }
  return data;
}

function guessTarget(pr) {
  const labels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  for (const t of ['ui', 'backend', 'agent', 'prompt']) if (labels.includes(t)) return t;
  const branch = pr.head?.ref || '';
  if (/mobile|ui|screen/i.test(branch)) return 'ui';
  if (/agent|voice/i.test(branch)) return 'agent';
  if (/prompt/i.test(branch)) return 'prompt';
  return 'backend';
}

// ─── The tick ────────────────────────────────────────────────────────────────

/**
 * Reconcile one batch. Cheap, idempotent, swallows its own errors — the same
 * shape as runDevBuildWorker, and safe to run beside it.
 */
export async function runReconcileTick(deps) {
  const { supabase, onTransition } = deps;
  if (!supabase || !isReconcileEnabled()) return { checked: 0, patched: 0, adopted: 0 };

  let snapshot;
  try {
    snapshot = await loadGitHubSnapshot();
  } catch (err) {
    console.error('[devReconcile] GitHub snapshot failed:', err.message);
    lastTick = { at: new Date().toISOString(), checked: 0, patched: 0, adopted: 0, error: err.message, skipped: null };
    return { checked: 0, patched: 0, adopted: 0, error: err.message };
  }

  const { data: rows } = await supabase
    .from('dev_build_requests')
    .select('*')
    .in('status', RECONCILABLE)
    .order('reconciled_at', { ascending: true, nullsFirst: true })
    .limit(BATCH);

  const now = Date.now();
  const seenPrNumbers = new Set();
  let patched = 0;
  let skipped = null;

  for (const row of rows || []) {
    if (row.archived) continue;

    // RATE GUARD. Bookkeeping must never starve the pipeline's own dispatch and
    // callback traffic. Stop the batch, keep what we did, resume next tick.
    const remaining = rateLimitRemaining();
    if (remaining !== null && remaining < RATE_FLOOR) {
      skipped = `github rate budget ${remaining} below floor ${RATE_FLOOR}`;
      console.warn(`[devReconcile] stopping batch early: ${skipped}`);
      break;
    }

    // PER-ROW ISOLATION — the fix for the stall that made the first version of
    // this module useless in practice. The loop had no try/catch, so ONE row
    // that threw aborted the entire tick; and because every row before it had
    // already had `reconciled_at` advanced, the next tick began at the same bad
    // row and died in the same place. Forever, silently. A reconciler that one
    // unlucky row can stop is not a reconciler.
    try {
      const didPatch = await reconcileRow({ supabase, row, snapshot, now, onTransition, seenPrNumbers });
      if (didPatch) patched += 1;
    } catch (err) {
      // String(...) not row.id.slice(...): the whole point of this block is to
      // survive a malformed row, and a row with no id would throw here too.
      console.error(`[devReconcile] row ${String(row.id).slice(0, 8)} failed:`, err.message);
      // Advance the cursor anyway: a row that always throws then costs one
      // attempt per pass instead of blocking every row behind it.
      await supabase
        .from('dev_build_requests')
        .update({ reconciled_at: new Date().toISOString() })
        .eq('id', row.id);
    }
  }

  const adopted = await adoptUntrackedPrs(supabase, snapshot, seenPrNumbers, now);

  lastTick = {
    at: new Date().toISOString(),
    checked: (rows || []).length,
    patched,
    adopted,
    error: null,
    skipped,
  };
  return { checked: (rows || []).length, patched, adopted, skipped };
}

/** Reconcile exactly one row. Returns true if it wrote a patch. */
async function reconcileRow({ supabase, row, snapshot, now, onTransition, seenPrNumbers }) {
  let pr = null;
  if (row.pr_number) pr = snapshot.prsByNumber.get(row.pr_number) || null;
  if (!pr && row.branch) pr = snapshot.prsByBranch.get(row.branch) || null;
  if (!pr) pr = snapshot.prsByBranch.get(`auto/dev-${row.id}`) || null;
  // A row whose PR fell off the recent page still has to be reconciled — this
  // is precisely the old, drifted row we most need to repair.
  if (!pr && row.pr_number) {
    try { pr = await githubJson(`pulls/${row.pr_number}`); } catch { pr = null; }
  }
  if (pr) seenPrNumbers.add(pr.number);

  let checks = null;
  if (pr && pr.state === 'open' && pr.head?.sha) {
    try {
      const body = await githubJson(`commits/${pr.head.sha}/check-runs?per_page=50`);
      checks = checksVerdict(body?.check_runs);
    } catch (err) {
      console.error('[devReconcile] check-runs failed:', err.message);
    }
  }

  let deploy = null;
  let touchesMobile = false;
  let release = null;
  if (pr && pr.merged_at) {
    if (pr.merge_commit_sha) deploy = snapshot.deployBySha.get(pr.merge_commit_sha) || null;
    touchesMobile = await prTouchesMobile(pr.number);
    if (row.release_id) {
      const { data: rel } = await supabase
        .from('releases').select('id, status, version').eq('id', row.release_id).single();
      release = rel || null;
    }
  }

  const patch = deriveState({
    row, pr, checks, deploy, lastGoodDeploy: snapshot.lastGoodDeploy,
    touchesMobile, release, trainEpoch: snapshot.trainEpoch, now,
  });

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    // Nothing to say, but record that we looked — otherwise this row is
    // re-checked first on every tick and newer rows starve.
    await supabase
      .from('dev_build_requests')
      .update({ reconciled_at: new Date().toISOString() })
      .eq('id', row.id);
    return false;
  }

  // Read the old status BEFORE writing: the patch is what we are about to
  // apply, and every consumer below reports the transition, not the result.
  const prevStatus = row.status;
  const nextStatus = patch.status ?? prevStatus;
  await applyPatch(supabase, row, patch, prevStatus);
  console.log(`[devReconcile] ${row.id.slice(0, 8)} ${prevStatus} -> ${nextStatus} (${keys.join(', ')})`);

  const workItemId = await syncWorkItem(supabase, row, nextStatus);
  await upsertChangeForRequest(
    supabase,
    { ...row, ...patch, work_item_id: workItemId },
    row.release_id,
    changeStatusFor(nextStatus),
  );

  if (patch.status && workItemId) {
    await supabase.from('pipeline_events').insert({
      kind: 'reconciled',
      work_item_id: workItemId,
      detail: { request_id: row.id, from: prevStatus, to: nextStatus, pr_number: pr?.number ?? null },
    }).then(({ error }) => { if (error) console.error('[devReconcile] event insert:', error.message); });
  }

  if (patch.status && typeof onTransition === 'function') {
    try {
      onTransition({ id: row.id, from: prevStatus, to: nextStatus, pr_number: pr?.number ?? null });
    } catch (err) {
      console.error('[devReconcile] onTransition:', err.message);
    }
  }

  return true;
}

/** Second pass: PRs with no row at all. */
async function adoptUntrackedPrs(supabase, snapshot, seenPrNumbers, now) {
  const recent = [...snapshot.prsByNumber.values()]
    .filter((pr) => now - new Date(pr.updated_at || pr.created_at).getTime() < ADOPT_WINDOW_MS)
    .filter((pr) => !seenPrNumbers.has(pr.number));
  if (recent.length === 0) return 0;

  const numbers = recent.map((pr) => pr.number);
  const { data: known } = await supabase
    .from('dev_build_requests')
    .select('id, pr_number')
    .in('pr_number', numbers);
  const knownNumbers = new Set((known || []).map((r) => r.pr_number));

  // A branch-named request may exist with its pr_number never recorded (the
  // pr_opened callback is one of the `|| true` ones). Check by id too, so
  // adoption never forks a row that already exists.
  const candidates = [];
  for (const pr of recent) {
    if (knownNumbers.has(pr.number)) continue;
    const requestId = requestIdForPr(pr, []);
    if (requestId) {
      const { data: byId } = await supabase
        .from('dev_build_requests').select('id').eq('id', requestId).limit(1);
      if (byId && byId[0]) continue;
    }
    candidates.push({ pr, requestId });
  }

  let adopted = 0;
  for (const { pr, requestId } of candidates.slice(0, ADOPT_PER_TICK)) {
    const row = await adoptPr(supabase, pr, requestId);
    if (row) {
      adopted += 1;
      console.log(`[devReconcile] adopted PR #${pr.number} as ${row.id.slice(0, 8)}`);
    }
  }
  if (candidates.length > ADOPT_PER_TICK) {
    console.log(`[devReconcile] ${candidates.length - ADOPT_PER_TICK} more PRs await adoption on the next tick`);
  }
  return adopted;
}
