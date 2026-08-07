/**
 * promptPr.js — the agent design loop's OUTPUT path: propose, never apply.
 *
 * WHY THIS EXISTS
 *
 * The design loop used to write the live system prompt directly. On Railway
 * that meant `persistPromptLive()` — a container write plus a volume mirror —
 * with no PR, no review, no CI. Two things followed from that, both of which
 * actually happened:
 *
 *  1. NOBODY REVIEWED IT. An unattended model call could change the buddy's
 *     behaviour for every user, and the only trace was an email after the
 *     fact. The prompt-size gate in ci.yml never saw those changes, so the
 *     only enforcement was the write-time fence in promptGuard.js.
 *  2. THE REPO AND THE LIVE PROMPT DIVERGED. The volume copy won at runtime
 *     and the repo copy was whatever was last committed from a dev machine,
 *     so `server/prompts/system.battlebuddy.md` stopped describing the
 *     product's actual behaviour.
 *
 * Both are the same bug: a change that skips the repo skips everything the
 * repo buys. So the loop now proposes. It patches the REPO copy of the prompt
 * on a branch, opens a PR, and files a dev_build_requests row so the proposal
 * lands on the pipeline page as an ordinary reviewable item. Merging it is a
 * human act; the deploy that follows is the same deploy as every other change,
 * which is what keeps the repo and the live prompt in sync from here on.
 *
 * THE BRANCH NAME IS LOAD-BEARING. `auto/dev-<request-id>` is the shape the
 * whole pipeline already recognises: devReconcile's UUID_RE is anchored on it
 * (so a lost pr_number re-links from the branch alone), ci.yml's `report` job
 * only posts check callbacks for branches with that prefix, and
 * auto-pr-hygiene.yml only keeps branches with that prefix landable. A
 * prettier name would silently opt out of all three. Auto-merge is NOT
 * enabled — autobuild.yml arms that for its own PRs only — so a design-loop
 * PR waits for a human, which is the entire point.
 */

import { createClient } from '@supabase/supabase-js';
import { githubFetch, githubJson } from './githubApi.js';

/** The one file the design loop is allowed to propose changes to. */
export const PROMPT_REPO_PATH = 'server/prompts/system.battlebuddy.md';

const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'main';

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    })
  : null;

/** Can this process open a PR at all? */
export function canOpenPr() {
  return !!process.env.GITHUB_TOKEN;
}

export function branchFor(requestId) {
  return `auto/dev-${requestId}`;
}

export const PR_TITLE = 'chore(prompt): design-loop proposed agent tuning from recent sessions';

// ─── Patch mechanics ──────────────────────────────────────────────────────────
//
// Patch-based, not a full-file rewrite: the model returns
// <<<FIND>>>/<<<REPLACE>>>/<<<END>>> blocks (~1-2k tokens) instead of the whole
// ~17k-token prompt, so a run finishes in ~30s instead of timing out at ten
// minutes — and a truncated response costs one dropped patch rather than
// silently deleting the tail of the file.

export function parsePatchBlocks(text) {
  const patches = [];
  const re = /<<<FIND>>>\n([\s\S]*?)\n<<<REPLACE>>>\n([\s\S]*?)\n<<<END>>>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    patches.push({ find: m[1], replace: m[2] });
  }
  return patches;
}

/**
 * Apply a parsed patch list to `base`.
 *
 * A FIND block that does not appear verbatim is skipped, not fatal: the model
 * paraphrases occasionally, and losing one patch out of three is a smaller
 * problem than losing the run. `applied` vs `total` is what the PR body and the
 * logs report, so a systematically bad batch is visible rather than silent.
 */
export function applyPatches(base, patches) {
  let content = base;
  let applied = 0;
  for (const { find, replace } of patches) {
    if (content.includes(find)) {
      content = content.replace(find, replace);
      applied++;
    } else {
      console.warn(`[DesignLoop] Patch FIND text not found in the repo prompt (first 80 chars): "${find.slice(0, 80).replace(/\n/g, '↵')}"`);
    }
  }
  return { content, applied, total: patches.length };
}

// ─── The proposal document ────────────────────────────────────────────────────

/**
 * PR body. Written for a human deciding merge-or-close in thirty seconds:
 * what changed, on what evidence, and which gates already ran — then the raw
 * proposal text underneath for anyone who wants the reasoning.
 */
export function buildPrBody({ requestId, summary, proposalText, digest, patchCount, sizeCheck, skipped = [] }) {
  const cap = sizeCheck ? `${sizeCheck.bytes} bytes` : 'not measured';
  const lines = [
    'Proposed by the BattleBuddy **agent design loop**. This is a proposal, not an applied change —',
    'nothing reaches the live prompt until this PR is merged and deployed.',
    '',
    `Analyzed **${digest?.totalSessions ?? 0} session(s)** across **${digest?.totalUsers ?? 0} user(s)**.`,
    '',
    '## Proposed changes',
    '',
    (summary || '_No summary generated._').trim(),
    '',
    '## What was applied to this branch',
    '',
    `- ${patchCount} HIGH-confidence patch(es) applied to \`${PROMPT_REPO_PATH}\``,
    '- MEDIUM / LOW confidence proposals were skipped — they need more evidence',
    `- Prompt size after patching: ${cap}`,
  ];

  if (skipped.length) {
    lines.push('', '## Skipped before this PR was opened', '');
    for (const s of skipped) lines.push(`- ${s}`);
  }

  lines.push(
    '',
    '## Review',
    '',
    'CI runs the prompt-size gate (`server/promptSize.test.js`) on this PR, so the byte cap is',
    'enforced here rather than by a silent write-time fence. Required runtime markers and the',
    'crisis off-ramp were checked before the branch was pushed.',
    '',
    '**Merge** to adopt the tuning. **Close** to reject it — the loop will re-propose only if the',
    'evidence recurs.',
    '',
    '<details><summary>Full proposal text from the design loop</summary>',
    '',
    '```',
    (proposalText || '').slice(0, 20000),
    '```',
    '',
    '</details>',
    '',
    `Dev-Request-Id: ${requestId}`,
  );

  return lines.join('\n');
}

/**
 * Commit message. The `Dev-Request-Id` trailer is the reconciler's second way
 * of linking a PR to its row (TRAILER_RE in devReconcile.js), so it survives a
 * branch rename that the anchored UUID_RE would not.
 */
export function buildCommitMessage(requestId, summary) {
  const body = (summary || '').trim().slice(0, 2000);
  return [
    PR_TITLE,
    '',
    body || 'HIGH-confidence proposals from the agent design loop.',
    '',
    'Proposed automatically — review before merging. Nothing is live until this lands.',
    '',
    `Dev-Request-Id: ${requestId}`,
  ].join('\n');
}

/** The pipeline row a proposal becomes. Pure, so the shape is testable. */
export function buildPipelineRow({ requestId, summary, prNumber, prUrl, branch, patchCount, digest, error = null }) {
  const opened = !!prNumber;
  return {
    id: requestId,
    source: 'design-loop',
    target: 'prompt',
    title: `Design loop: proposed system-prompt tuning (${patchCount} change${patchCount === 1 ? '' : 's'})`,
    description: (summary || '').slice(0, 2000) || null,
    confidence: 0.9,
    spec: {
      acceptanceCriteria: [
        'Prompt-size gate passes on the PR',
        'Required runtime markers and the 988 off-ramp survive the change',
      ],
      affectedFiles: [PROMPT_REPO_PATH],
      // Not a build request: the change is already written on the branch. The
      // worker never dispatches this row (it only selects `pending`), and this
      // field exists so a human reading the row knows why.
      claudeCodePrompt: 'No build needed — the design loop already wrote the change to the branch. Review the PR.',
      patchCount,
      sessionsAnalyzed: digest?.totalSessions ?? 0,
      usersAnalyzed: digest?.totalUsers ?? 0,
    },
    // `in_review` is the honest state: an open PR waiting on CI and a human.
    // It counts against DEV_MAX_CONCURRENT and carries the 120-minute in_review
    // stage TTL — so an unreviewed proposal gives its build slot back and lands
    // in "Needs attention" rather than holding a slot forever. Once merged, the
    // reconciler drives it on to deploying/deployed like any other row.
    status: opened ? 'in_review' : 'needs_attention',
    branch: branch || null,
    pr_number: prNumber || null,
    pr_url: prUrl || null,
    checks_status: opened ? 'running' : null,
    error: opened ? null : (error || 'Design loop could not open a PR for this proposal.').slice(0, 300),
    // Unique per run: this row must never dedupe against — or block — anything.
    dedupe_key: `design-loop:${requestId}`,
    entered_at: new Date().toISOString(),
    history: [{
      at: new Date().toISOString(),
      to: opened ? 'in_review' : 'needs_attention',
      note: opened
        ? `design-loop — proposed PR #${prNumber} for review`
        : `design-loop — proposal could not be opened as a PR: ${error || 'unknown error'}`,
    }],
  };
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

/**
 * The REPO copy of the system prompt — the base every patch must apply to.
 *
 * Deliberately not the live/volume copy. A PR is a diff against the repo, so a
 * FIND block generated against a diverged live file would either fail to match
 * or produce a diff that means nothing to a reviewer.
 */
export async function fetchRepoPrompt() {
  const file = await githubJson(`contents/${PROMPT_REPO_PATH}?ref=${BASE_BRANCH}`);
  return {
    content: Buffer.from(file.content, 'base64').toString('utf-8'),
    sha: file.sha,
  };
}

async function createBranch(branch) {
  const ref = await githubJson(`git/ref/heads/${BASE_BRANCH}`);
  await githubFetch('git/refs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
  });
}

async function commitPrompt({ branch, content, fileSha, message }) {
  await githubFetch(`contents/${PROMPT_REPO_PATH}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha: fileSha,
      branch,
    }),
  });
}

async function openPr({ branch, body }) {
  const pr = await githubJson('pulls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: PR_TITLE, head: branch, base: BASE_BRANCH, body }),
  });
  return { number: pr.number, url: pr.html_url };
}

// ─── The pipeline item ────────────────────────────────────────────────────────

/**
 * File the proposal on the pipeline board.
 *
 * Never throws: a failed insert must not lose the PR. If this row cannot be
 * written (the classic case being a deploy that shipped this code before
 * migration 022 widened the `source` check), devReconcile adopts the untracked
 * PR on its next tick and the proposal still becomes a visible pipeline item —
 * just labelled `github` instead of `design-loop`.
 */
export async function recordPipelineItem(row) {
  if (!supabase) {
    console.warn('[DesignLoop] No Supabase client — proposal not filed on the pipeline board');
    return { ok: false, error: 'supabase not configured' };
  }
  const { error } = await supabase.from('dev_build_requests').insert(row);
  if (error) {
    console.error('[DesignLoop] pipeline row insert failed:', error.message);
    return { ok: false, error: error.message };
  }
  console.log(`[DesignLoop] Pipeline item ${row.id} filed (${row.status}, PR #${row.pr_number ?? 'none'})`);
  return { ok: true };
}

// ─── The whole output path ────────────────────────────────────────────────────

/**
 * Push the proposed prompt to a branch, open a PR, and file the pipeline row.
 *
 * @returns {Promise<{ok: boolean, requestId: string, branch: string,
 *   prNumber?: number, prUrl?: string, pipelineFiled: boolean, error?: string}>}
 */
export async function proposePromptChange({
  requestId,
  content,
  fileSha,
  summary,
  proposalText,
  digest,
  patchCount,
  sizeCheck,
  skipped = [],
}) {
  const branch = branchFor(requestId);
  let prNumber = null;
  let prUrl = null;
  let error = null;

  try {
    await createBranch(branch);
    await commitPrompt({
      branch,
      content,
      fileSha,
      message: buildCommitMessage(requestId, summary),
    });
    const pr = await openPr({
      branch,
      body: buildPrBody({ requestId, summary, proposalText, digest, patchCount, sizeCheck, skipped }),
    });
    prNumber = pr.number;
    prUrl = pr.url;
    console.log(`[DesignLoop] Opened PR #${prNumber} on ${branch}: ${prUrl}`);
  } catch (err) {
    error = err.message;
    console.error('[DesignLoop] Could not open the proposal PR:', error);
  }

  // The row is written either way. A proposal that failed to become a PR is
  // still something Mike has to see; silence is the failure mode this pipeline
  // exists to prevent.
  const filed = await recordPipelineItem(
    buildPipelineRow({ requestId, summary, prNumber, prUrl, branch, patchCount, digest, error }),
  );

  return {
    ok: !!prNumber,
    requestId,
    branch,
    ...(prNumber ? { prNumber, prUrl } : {}),
    pipelineFiled: filed.ok,
    ...(error ? { error } : {}),
  };
}
