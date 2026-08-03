// devRelease.js — the build train's bookkeeping.
//
// mobile-release.yml runs ONE mobile build at a time (see the header comment
// there). Because merges that land mid-build ride the next build, a build is no
// longer 1:1 with a change — it carries a batch. A `releases` row is that batch:
// which Actions run built it, at which commit, which requests it carried, and a
// changelog naming each of them.
//
// Two properties this module is built around:
//
//  * Idempotent on the Actions run id. /dev/release/start, /dev/release/complete
//    and (stage 2) the reconciler all upsert on `run_id`, so a retried callback,
//    a lost callback later backfilled, and a reconciler sweep all converge on
//    the same single row. Correctness must not depend on delivery — that is the
//    whole reason the app used to drift.
//
//  * Membership is derived from git, not from what a workflow remembered to
//    tell us. The commits between the last release and this one carry
//    `Dev-Request-Id:` trailers (autobuild writes them) and squash-merge
//    subjects carry `(#123)`, so the batch can always be recomputed from GitHub.

import { githubJson } from './githubApi.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TRAILER_RE = new RegExp(`^Dev-Request-Id:\\s*(${UUID})\\s*$`, 'gim');
// GitHub squash merges title the commit "<pr title> (#123)"; the number is on
// the subject line only, so anchor to the first line and never scan the body
// (a body that quotes "#12" is not a merge of PR 12).
const SQUASH_PR_RE = /\(#(\d+)\)\s*$/;

/** Dev-Request-Id trailers across a set of commits, de-duplicated, in order. */
export function parseDevRequestIds(commits) {
  const out = [];
  for (const c of commits || []) {
    const message = c?.message || '';
    for (const m of message.matchAll(TRAILER_RE)) {
      const id = m[1].toLowerCase();
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** PR numbers from squash-merge subject lines, de-duplicated, in order. */
export function parsePrNumbers(commits) {
  const out = [];
  for (const c of commits || []) {
    const subject = (c?.message || '').split('\n')[0];
    const m = subject.match(SQUASH_PR_RE);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * "Build 12 — 3 changes" plus one line per change, each linked to its PR.
 *
 * This is the text the Dev screen shows on a release group, so it has to read
 * as a human sentence even when the batch is empty (a mobile change can land
 * with no tracked request behind it — a hand edit, or a request the reconciler
 * has not adopted yet).
 */
export function buildChangelog(version, entries) {
  const list = entries || [];
  const head = `Build ${version} — ${list.length} change${list.length === 1 ? '' : 's'}`;
  const lines = list.map((e) => {
    const link = e.pr_number ? ` (#${e.pr_number})` : '';
    return `- ${e.title || 'untitled change'}${link}`;
  });
  return [head, ...lines].join('\n');
}

/** Highest existing version + 1. Versions are dense and start at 1. */
export function nextVersion(rows) {
  let max = 0;
  for (const r of rows || []) {
    const v = Number(r?.version);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max + 1;
}

// ─── GitHub reads ────────────────────────────────────────────────────────────

/**
 * Commits carried by this build: everything between the previous release's
 * commit and this one.
 *
 * With no previous release we deliberately take ONLY the head commit rather
 * than guessing a window. Under-claiming is safe — the stage-2 reconciler marks
 * a merged change deployed from the Deploy run for its own merge commit, so a
 * change left out of the very first release still reaches the right state. Over-
 * claiming is not: it would stamp `release_id` onto changes this build never
 * contained.
 */
export async function commitsCarried(baseSha, headSha) {
  if (baseSha && baseSha !== headSha) {
    const body = await githubJson(`compare/${baseSha}...${headSha}`);
    return (body.commits || []).map((c) => ({ sha: c.sha, message: c.commit?.message || '' }));
  }
  const body = await githubJson(`commits/${headSha}`);
  return [{ sha: body.sha, message: body.commit?.message || '' }];
}

// ─── Release lifecycle ───────────────────────────────────────────────────────

/** The release we last built from, used as the diff base for the next one. */
async function previousRelease(supabase, runId) {
  const { data } = await supabase
    .from('releases')
    .select('id, version, commit_sha, run_id')
    .not('commit_sha', 'is', null)
    .order('version', { ascending: false })
    .limit(5);
  return (data || []).find((r) => r.run_id !== runId) || null;
}

/**
 * Find or create the release row for an Actions run.
 *
 * The version race is real once stage 3 lets an expedited build run beside the
 * train, so a unique-violation on insert re-reads and retries rather than
 * failing the callback.
 */
export async function upsertRelease(supabase, { runId, runNumber, commitSha, expediteRequestId }) {
  const key = String(runId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: found } = await supabase
      .from('releases')
      .select('*')
      .eq('run_id', key)
      .limit(1);
    if (found && found[0]) return found[0];

    const { data: all } = await supabase.from('releases').select('version');
    const row = {
      version: nextVersion(all),
      run_id: key,
      run_number: runNumber ?? null,
      commit_sha: commitSha || null,
      status: 'building',
      started_at: new Date().toISOString(),
      platform: 'ios',
      expedite_request_id: expediteRequestId || null,
    };
    const { data: inserted, error } = await supabase.from('releases').insert(row).select('*').single();
    if (!error && inserted) return inserted;
    // Unique violation on version or run_id — another writer won; re-read.
    console.warn('[devRelease] release insert retry:', error?.message);
  }
  return null;
}

/**
 * Work out which build requests this release carries and link them.
 *
 * Returns the linked rows. Safe to call repeatedly: it only ever sets
 * `release_id` on requests and upserts one `changes` row per request.
 */
export async function linkReleaseContents(supabase, release) {
  const prev = await previousRelease(supabase, release.run_id);
  let commits = [];
  try {
    commits = await commitsCarried(prev?.commit_sha, release.commit_sha);
  } catch (err) {
    console.error('[devRelease] could not read carried commits:', err.message);
    return [];
  }

  const ids = parseDevRequestIds(commits);
  const prNumbers = parsePrNumbers(commits);
  if (ids.length === 0 && prNumbers.length === 0) return [];

  const byId = new Map();
  const collect = (rows) => {
    for (const r of rows || []) if (!byId.has(r.id)) byId.set(r.id, r);
  };

  if (ids.length > 0) {
    const { data } = await supabase.from('dev_build_requests').select('*').in('id', ids);
    collect(data);
  }
  if (prNumbers.length > 0) {
    const { data } = await supabase.from('dev_build_requests').select('*').in('pr_number', prNumbers);
    collect(data);
  }

  const rows = [...byId.values()];
  for (const r of rows) {
    if (r.release_id !== release.id) {
      await supabase
        .from('dev_build_requests')
        .update({ release_id: release.id, updated_at: new Date().toISOString() })
        .eq('id', r.id);
    }
    await upsertChangeForRequest(supabase, r, release.id);
  }
  return rows;
}

/**
 * One `changes` row per build request, carrying the release link.
 *
 * `changes` sat empty from migration 018 until now because nothing wrote it —
 * it is the join between a work item and the PR that implements it, and the
 * releases view on the Dev screen reads it.
 */
export async function upsertChangeForRequest(supabase, request, releaseId, status) {
  const patch = {
    ...(status ? { status } : {}),
    dev_request_id: request.id,
    work_item_id: request.work_item_id || null,
    title: request.title || null,
    branch: request.branch || null,
    pr_number: request.pr_number || null,
    pr_url: request.pr_url || null,
    release_id: releaseId || request.release_id || null,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from('changes')
    .select('id')
    .eq('dev_request_id', request.id)
    .limit(1);

  if (existing && existing[0]) {
    await supabase.from('changes').update(patch).eq('id', existing[0].id);
    return existing[0].id;
  }
  const { data: inserted, error } = await supabase
    .from('changes')
    .insert({ status: 'merged', ...patch })
    .select('id')
    .single();
  if (error) {
    console.error('[devRelease] changes insert failed:', error.message);
    return null;
  }
  return inserted?.id || null;
}

/** POST /dev/release/start — open the release and name what it carries. */
export async function startRelease(supabase, payload) {
  const release = await upsertRelease(supabase, payload);
  if (!release) throw new Error('could not open a release row');

  const carried = await linkReleaseContents(supabase, release);
  const changelog = buildChangelog(release.version, carried);
  await supabase
    .from('releases')
    .update({ changelog, status: 'building' })
    .eq('id', release.id);

  return { ...release, changelog, change_count: carried.length };
}

/**
 * POST /dev/release/complete — close the release and settle every request it
 * carried.
 *
 * Re-links first: `start` may never have landed (server restart, network), and
 * a build that reports only at the end must still know its own contents.
 */
export async function completeRelease(supabase, payload) {
  const { status, error: errorText } = payload;
  const live = status === 'live';

  const release = await upsertRelease(supabase, payload);
  if (!release) throw new Error('could not open a release row');

  const carried = await linkReleaseContents(supabase, release);
  const changelog = buildChangelog(release.version, carried);

  await supabase
    .from('releases')
    .update({
      status: live ? 'live' : 'failed',
      changelog,
      completed_at: new Date().toISOString(),
      notes: live ? null : String(errorText || 'build failed').slice(0, 500),
    })
    .eq('id', release.id);

  // The train is why this exists: a superseded pending run never executes and
  // therefore never reports, so "my own run finished" cannot be the completion
  // signal. The release that carried the change is.
  for (const r of carried) {
    if (r.status === 'deployed' || r.status === 'duplicate' || r.status === 'superseded') continue;
    await supabase
      .from('dev_build_requests')
      .update({
        status: live ? 'deployed' : 'failed',
        deploy_status: live ? 'ok' : 'failed',
        error: live ? null : String(errorText || 'mobile build failed').slice(0, 300),
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id);

    await supabase
      .from('changes')
      .update({ status: live ? 'deployed' : 'failed', updated_at: new Date().toISOString() })
      .eq('dev_request_id', r.id);
  }

  return { ...release, changelog, change_count: carried.length, status: live ? 'live' : 'failed' };
}
