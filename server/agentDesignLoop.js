/**
 * Agent Design Loop — reads accumulated session data across users, proposes
 * targeted updates to agent.md, turns the HIGH confidence ones into patches
 * against the REPO copy of system.battlebuddy.md, and OPENS A PULL REQUEST
 * plus a pipeline item for review. It emails a summary of what it proposed.
 *
 * IT NO LONGER WRITES THE LIVE PROMPT. Until 2026-08-07 it called
 * persistPromptLive() and the change was live on the next turn: no PR, no
 * review, no CI, and the repo copy left behind. Everything about that was the
 * same mistake — a change that skips the repo skips review, skips the
 * prompt-size gate, and desynchronises the file from the behaviour it is
 * supposed to describe. The output is now a proposal; a human merges it, and
 * the ordinary deploy makes it live. See server/promptPr.js.
 *
 * Runs in TWO modes, and both now propose rather than apply:
 *  - In-process on bb-server (production): scheduled daily from index.js and
 *    on demand via POST /admin/console/design-loop/run.
 *  - CLI on a dev machine:
 *      node server/agentDesignLoop.js [--dry-run] [--remote] [--email] [--users=id1,id2]
 *
 * Both paths open the PR through the GitHub REST API with the same
 * GITHUB_TOKEN the rest of the pipeline uses, so neither depends on a git
 * checkout, a laptop being awake, or credentials in the container.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { ADMIN_DATA_ROOT, buildInsightsFeedback, listKnownProfiles } from './contextAgent.js';
import { validateProposedPrompt } from './promptGuard.js';
import {
  applyPatches, canOpenPr, fetchRepoPrompt, parsePatchBlocks, proposePromptChange,
} from './promptPr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = resolve(__dirname, '.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1);
    }
  }
} catch {}

const client = new Anthropic();

const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;

const STORE_DIR = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
const AGENT_MD = resolve(__dirname, '..', 'agent.md');
const SYSTEM_PROMPT = resolve(__dirname, 'prompts', 'system.battlebuddy.md');
// In prod the repo dirs aren't in the image / aren't durable — use the volume.
const PROPOSALS_DIR = ON_RAILWAY ? resolve(ADMIN_DATA_ROOT, 'agent-proposals') : resolve(__dirname, '..', 'agent-proposals');

// The design doc the loop reasons over. The repo copy (../agent.md) isn't in
// the production image, so prod uses a console-managed copy on the volume
// (POST /admin/console/agent-md); the volume copy wins everywhere when present.
export const AGENT_MD_VOLUME_PATH = resolve(ADMIN_DATA_ROOT, 'agent.md');

export function readAgentMd() {
  try {
    if (existsSync(AGENT_MD_VOLUME_PATH)) return { content: readFileSync(AGENT_MD_VOLUME_PATH, 'utf-8'), source: 'volume' };
    if (existsSync(AGENT_MD)) return { content: readFileSync(AGENT_MD, 'utf-8'), source: 'repo' };
  } catch {}
  return { content: null, source: 'none' };
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REMOTE = args.includes('--remote');
const EMAIL = args.includes('--email') || process.env.DESIGN_LOOP_EMAIL_ON === '1';
const userFilter = args.find(a => a.startsWith('--users='))?.split('=')[1]?.split(',');

const EMAIL_TO = process.env.DESIGN_LOOP_EMAIL_TO || 'mike@strangepair.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REMOTE_BASE_URL = process.env.BB_SERVER_URL || 'https://bb-server-production-a849.up.railway.app';

// ── Load all user profiles ────────────────────────────────────────────────────

async function fetchRemoteProfile(userId) {
  const res = await fetch(`${REMOTE_BASE_URL}/context/profile/${userId}`, {
    headers: { 'x-bb-admin-secret': process.env.BB_ADMIN_SECRET || '' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${userId}`);
  const data = await res.json();
  return data.profile || data;
}

async function loadAllProfiles(remote = false) {
  if (remote) {
    // Dev-CLI-only path (`node server/agentDesignLoop.js --remote`): profiles
    // themselves come from the live server over HTTP, but candidate userIds
    // still come from whatever's on this machine's local volume checkout —
    // a user created after profiles moved to Supabase won't show up here
    // unless their file also happens to exist locally. Not used in production
    // (see the in-process branch below).
    const files = readdirSync(STORE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('default'));
    const userIds = files.map(f => f.replace('.json', ''));
    const profiles = [];
    for (const userId of userIds) {
      if (userFilter && !userFilter.includes(userId)) continue;
      try {
        const raw = await fetchRemoteProfile(userId);
        profiles.push({ userId, ...raw });
        console.log(`[DesignLoop] Fetched remote profile for ${userId} (${raw.session_count || 0} sessions)`);
      } catch (e) {
        console.warn(`[DesignLoop] Could not fetch remote profile ${userId}: ${e.message}`);
      }
    }
    return profiles;
  }

  // In-process (production): read straight from the live cache, backed by
  // Supabase's user_profiles — the volume is no longer where saveProfile writes.
  return listKnownProfiles().filter(p => !userFilter || userFilter.includes(p.userId));
}

// ── Build signal digest from profiles ────────────────────────────────────────

function buildSignalDigest(profiles) {
  const digest = {
    totalSessions: 0,
    totalUsers: profiles.length,
    whatWorks: [],
    whatDoesntWork: [],
    userQuotes: [],
    recentInsights: [],
    nextSessionHints: [],
    openDesignQuestions: [],
  };

  for (const p of profiles) {
    digest.totalSessions += p.session_count || 0;

    const take = (arr, n = 15) => (arr || []).slice(-n).map(i =>
      typeof i === 'string' ? i : (i.value || '')
    ).filter(Boolean);

    digest.whatWorks.push(...take(p.what_works));
    digest.whatDoesntWork.push(...take(p.what_doesnt_work));
    digest.userQuotes.push(...take(p.user_quotes, 10));
    digest.recentInsights.push(...take(p.recent_insights, 10));
    digest.nextSessionHints.push(...take(p.next_session_hints, 10));
    digest.openDesignQuestions.push(...take(p.unknowns, 5));
  }

  return digest;
}

// ── Propose design updates ────────────────────────────────────────────────────

async function proposeDesignUpdates(agentMd, digest) {
  const adminFeedback = buildInsightsFeedback();
  const systemPrompt = `You are a product design meta-agent for BattleBuddy, a smoking/vaping cessation companion app.

Your job: read the current agent design document (agent.md) and a digest of real session signals, then propose specific, targeted updates to agent.md.

Rules:
- Propose ONLY changes supported by observed evidence in the signal digest. No speculation.
- Use the user's own language where it appears in quotes — their words are better than ours.
- Flag contradictions between what agent.md says and what the session data shows.
- Flag gaps — patterns in the data that agent.md doesn't address.
- Flag what's working well and should be reinforced in the document.
- Propose additions to the "What's working" and "What's not working" sections based on new evidence.
- Propose additions to "The user's own language" table when new phrases appear.
- Propose updates to open design questions when sessions provide answers.
- Never propose removing safety content or the crisis off-ramp.
- Format each proposal as a clearly labeled block: SECTION, CHANGE TYPE (add/update/remove), and the proposed content.
- Rate each proposal: HIGH (clear evidence, auto-apply), MEDIUM (pattern emerging, watch), LOW (single instance, watch).

Be concise. One proposal per finding. Do not repeat what's already in agent.md unless it needs updating.`;

  const userMessage = `Here is the current agent.md:

<agent_md>
${agentMd}
</agent_md>

Here is the signal digest from ${digest.totalUsers} user(s) across ${digest.totalSessions} total sessions:

<what_works>
${digest.whatWorks.map((w, i) => `${i + 1}. ${w}`).join('\n')}
</what_works>

<what_doesnt_work>
${digest.whatDoesntWork.map((w, i) => `${i + 1}. ${w}`).join('\n')}
</what_doesnt_work>

<user_quotes>
${digest.userQuotes.map((q, i) => `${i + 1}. ${q}`).join('\n')}
</user_quotes>

<recent_insights>
${digest.recentInsights.map((r, i) => `${i + 1}. ${r}`).join('\n')}
</recent_insights>

<open_design_questions>
${digest.openDesignQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}
</open_design_questions>

${adminFeedback ? `The admin reviews recommendations in a console; his verdicts on past ones — calibrate proposals to them:

<admin_feedback>
${adminFeedback}
</admin_feedback>

` : ''}Propose specific updates to agent.md. For each proposal, include:
- SECTION: which section of agent.md this affects
- CONFIDENCE: HIGH / MEDIUM / LOW
- CHANGE TYPE: add / update / remove
- EVIDENCE: the specific signal(s) that support this change (quote directly from the digest)
- PROPOSED CONTENT: the exact text to add or replace`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text;
}

// ── Turn HIGH confidence proposals into a proposed system prompt ──────────────

async function buildProposedPrompt(proposalText, currentSystemPrompt) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are turning HIGH confidence proposals into surgical patches to an AI system prompt.

For each HIGH confidence proposal, output one patch block:
<<<FIND>>>
[exact verbatim text from the current system prompt to replace — copy it character-for-character]
<<<REPLACE>>>
[updated text]
<<<END>>>

Rules:
- Only emit patches for HIGH confidence proposals. Skip MEDIUM and LOW.
- The FIND text MUST appear verbatim in the current system prompt (copy-paste it, do not paraphrase).
- For new content being ADDED to an existing section, set FIND to the last line of that section and REPLACE to that same line plus the new content below it.
- Output ONLY patch blocks — no preamble, no explanation, no markdown fences.
- Never output a patch that removes safety content, the 988 crisis off-ramp, or {{placeholder}} variables.
- If there are no HIGH confidence proposals, output nothing.`,
    messages: [{
      role: 'user',
      content: `## Proposals (patch HIGH confidence only):

${proposalText}

## Current system prompt (the repo copy your FIND blocks must match):

${currentSystemPrompt}`,
    }],
  });

  const patches = parsePatchBlocks(response.content[0].text);

  if (patches.length === 0) {
    console.log('[DesignLoop] Patch response contained no valid patch blocks — no HIGH confidence proposals or none matched.');
    return { content: currentSystemPrompt, applied: 0, total: 0 };
  }

  const result = applyPatches(currentSystemPrompt, patches);
  console.log(`[DesignLoop] Prepared ${result.applied}/${result.total} patch(es) for the proposal branch`);
  return result;
}

// ── Summarize what is being proposed ──────────────────────────────────────────
//
// One summary, two consumers: the PR body a reviewer reads and the email Mike
// gets. They must not be able to disagree about what was proposed.

async function generateProposalSummary(proposalText, promptBefore, promptAfter, digest) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You are writing a concise change-proposal summary for a developer reviewing a pull request. Given proposals and current/proposed system prompt versions:
- List only what is being PROPOSED (HIGH confidence proposals) — nothing here is live yet
- One bullet per change, plain English, 1 sentence each, and say briefly what evidence motivated it
- Note how many MEDIUM/LOW proposals were skipped and will need more evidence
- End with the session count analyzed
No preamble. Clean markdown.`,
    messages: [{
      role: 'user',
      content: `PROPOSALS:\n${proposalText}\n\nSYSTEM PROMPT AS IT IS TODAY (first 3000 chars):\n${promptBefore.slice(0, 3000)}\n\nSYSTEM PROMPT AS PROPOSED (first 3000 chars):\n${promptAfter.slice(0, 3000)}\n\nSessions analyzed: ${digest.totalSessions} across ${digest.totalUsers} user(s).`,
    }],
  });
  return response.content[0].text;
}

// ── File management ───────────────────────────────────────────────────────────

// No backup function any more: the proposal lands as a commit on a branch, so
// git history IS the rollback path — `prompts/backups/` existed only because
// the old auto-apply overwrote a live file with nothing behind it.

// Bumps the minor version in the PROMPT_VERSION header and re-stamps today's date.
function bumpPromptVersion(content) {
  const versionRegex = /<!-- PROMPT_VERSION: v(\d+)\.(\d+) — .+ -->/;
  const match = content.match(versionRegex);
  if (!match) {
    console.log('[DesignLoop] No PROMPT_VERSION header found — skipping version bump');
    return content;
  }
  const [, major, minor] = match;
  const nextVersion = `v${major}.${Number(minor) + 1}`;
  const date = new Date().toISOString().slice(0, 10);
  console.log(`[DesignLoop] Bumping prompt version to ${nextVersion} (${date})`);
  return content.replace(versionRegex, `<!-- PROMPT_VERSION: ${nextVersion} — ${date} -->`);
}

function writeProposal(proposalText, digest) {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `proposal-${timestamp}.md`;
  const filepath = resolve(PROPOSALS_DIR, filename);

  const content = `# agent.md Update Proposal — ${new Date().toISOString().slice(0, 10)}

Generated by: agent design loop
Users analyzed: ${digest.totalUsers}
Total sessions: ${digest.totalSessions}

---

${proposalText}
`;
  writeFileSync(filepath, content);
  return filepath;
}

// The proposal file is no longer archived to `applied/` when a run succeeds —
// nothing is applied. It stays where it was written, next to every other
// proposal, and the PR is the record of what happened to it.
//
// There is no commitAndPush() either. The dev-machine path used to `git commit`
// and `git push origin main` — a direct push to the default branch from an
// unattended script, which is the same governance hole as persistPromptLive()
// wearing different clothes. Both paths now go through the REST API onto a
// branch, and the only way to main is a merged PR.

// ── Send email ────────────────────────────────────────────────────────────────

async function sendProposalEmail(summary, digest, outcome) {
  if (!RESEND_API_KEY) {
    console.warn('[DesignLoop] RESEND_API_KEY not set — skipping email');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = outcome.prNumber
    ? `BattleBuddy — prompt change proposed for review (PR #${outcome.prNumber})`
    : `BattleBuddy — prompt proposal needs attention ${date}`;

  const footer = outcome.prNumber
    ? `Nothing is live yet. Review and merge <a href="${outcome.prUrl}">PR #${outcome.prNumber}</a> to apply it — `
      + 'it is also on the pipeline page as a normal reviewable item, and the deploy that follows the '
      + 'merge is what makes it live.'
    : `No PR was opened. ${escapeHtml(outcome.reason || 'Unknown reason.')} `
      + 'The proposal is kept for manual review; nothing was changed.';

  const skippedHtml = (outcome.skipped || []).length
    ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px;margin:16px 0;border-radius:4px;">
         <strong>Skipped before opening a PR</strong>
         <ul>${outcome.skipped.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
       </div>`
    : '';

  const html = `
<html><body style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; color: #1a1a1a; line-height: 1.6;">
  <h2 style="border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">BattleBuddy — prompt change proposed</h2>
  <p style="color: #6b7280; font-size: 14px;">${date} · ${digest.totalSessions} sessions analyzed · ${digest.totalUsers} user(s)</p>
  <div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 16px; margin: 20px 0; border-radius: 4px;">
    ${summary
      .replace(/^## (.+)$/gm, '<h3 style="margin-top:16px">$1</h3>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n\n/g, '</p><p>')
    }
  </div>
  ${skippedHtml}
  <p style="color: #6b7280; font-size: 13px;">${footer}</p>
</body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'BattleBuddy <design-loop@battlebuddy.network>',
      to: [EMAIL_TO],
      subject,
      html,
      text: summary,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn(`[DesignLoop] Email failed: ${res.status} ${err}`);
  } else {
    console.log(`[DesignLoop] Proposal email sent to ${EMAIL_TO}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runDesignLoop({ email = false, dryRun = false, remote = false, trigger = 'cli', onProgress = null } = {}) {
  const progress = (stage) => { if (onProgress) onProgress(stage); };
  console.log(`[DesignLoop] Starting agent design loop (trigger: ${trigger})...`);

  if (!existsSync(SYSTEM_PROMPT)) {
    throw new Error(`system.battlebuddy.md not found at ${SYSTEM_PROMPT}`);
  }

  // Design doc: volume copy > repo copy > (last resort) the system prompt
  // itself, which is the live behavioral document.
  progress('Loading agent doc');
  const agentMdInfo = readAgentMd();
  const systemPromptBefore = readFileSync(SYSTEM_PROMPT, 'utf-8');
  const agentMd = agentMdInfo.content || systemPromptBefore;
  if (agentMdInfo.source === 'none') {
    console.warn('[DesignLoop] No agent.md found (volume or repo) — reasoning over the system prompt itself. Seed one via POST /admin/console/agent-md.');
  }
  console.log(`[DesignLoop] Loaded agent.md from ${agentMdInfo.source} (${agentMd.length} chars), system prompt (${systemPromptBefore.length} chars)`);

  progress('Loading profiles');
  const profiles = await loadAllProfiles(remote);
  if (profiles.length === 0) {
    throw new Error(`No user profiles found in ${STORE_DIR}`);
  }
  console.log(`[DesignLoop] Loaded ${profiles.length} user profile(s)`);

  const digest = buildSignalDigest(profiles);
  console.log(`[DesignLoop] Signal digest: ${digest.totalSessions} sessions, ${digest.whatWorks.length} what-works, ${digest.whatDoesntWork.length} what-doesnt-work`);

  if (dryRun) {
    console.log('[DesignLoop] DRY RUN — digest built, skipping LLM calls');
    return { ok: true, dryRun: true, changed: false, users: digest.totalUsers, sessions: digest.totalSessions };
  }

  progress('Analyzing signals');
  console.log('[DesignLoop] Calling Sonnet to analyze and propose updates...');
  const proposals = await proposeDesignUpdates(agentMd, digest);

  const proposalPath = writeProposal(proposals, digest);
  console.log(`[DesignLoop] Proposal written to: ${proposalPath}`);

  const base = { ok: true, proposalPath, users: digest.totalUsers, sessions: digest.totalSessions };

  // Without a token there is no propose path at all — and there is no longer a
  // fallback that writes the live prompt, by design. Say so loudly and stop:
  // a design loop that quietly does nothing is how the last one got away with
  // quietly doing everything.
  if (!canOpenPr()) {
    const reason = 'GITHUB_TOKEN is not set, so no PR could be opened. Set it on bb-server '
      + '(same token the dev pipeline uses) — the design loop no longer has any path that writes the prompt directly.';
    console.error(`[DesignLoop] ${reason}`);
    if (email) await sendProposalEmail(proposals.slice(0, 4000), digest, { reason, skipped: [] });
    return { ...base, changed: false, proposed: false, skippedReason: reason };
  }

  // The patch base is the REPO copy, not the live one. A PR is a diff against
  // the repo, so FIND blocks generated against a diverged live file would not
  // apply — and this is also what re-syncs the two: from here on, the repo is
  // where a prompt change starts.
  progress('Reading repo prompt');
  const repoPrompt = await fetchRepoPrompt();
  console.log(`[DesignLoop] Repo prompt loaded from GitHub (${repoPrompt.content.length} chars)`);

  progress('Preparing proposal');
  console.log('[DesignLoop] Turning HIGH confidence proposals into patches...');
  const patched = await buildProposedPrompt(proposals, repoPrompt.content);

  if (patched.content.trim() === repoPrompt.content.trim()) {
    console.log('[DesignLoop] Nothing to propose — the repo prompt already says this');
    return { ...base, changed: false, proposed: false };
  }

  // Bump BEFORE validating, so the bytes that were checked are exactly the
  // bytes that get committed.
  const proposedPrompt = bumpPromptVersion(patched.content);

  // Marker + size gates, run against the PROPOSED content before anything is
  // pushed. A proposal that fails them is dropped here: a junk PR costs a human
  // a read and a close, and the whole point of this change is to spend Mike's
  // review attention only on proposals worth reviewing. CI re-runs the size
  // gate on the PR, which is what actually blocks a bad merge.
  const check = validateProposedPrompt(proposedPrompt, repoPrompt.content);
  if (!check.ok) {
    const { violations } = check;
    console.warn(`[DesignLoop] Proposal failed its gates, no PR opened: ${violations.join('; ')}`);
    const reason = `The proposal failed its pre-PR checks: ${violations.join('; ')}. `
      + `Kept for manual review at ${proposalPath}. Fold changes in by tightening or replacing existing content, not appending.`;
    if (email) await sendProposalEmail(proposals.slice(0, 4000), digest, { reason, skipped: violations });
    return { ...base, changed: false, proposed: false, skipped: violations, skippedReason: reason };
  }

  // A FIND block that did not match is a patch that silently did not happen.
  // Say so on the PR rather than letting the reviewer assume the summary
  // describes the diff in full.
  const skipped = patched.applied < patched.total
    ? [`${patched.total - patched.applied} of ${patched.total} patch(es) dropped: the FIND text did not appear verbatim in the repo prompt`]
    : [];

  console.log('[DesignLoop] Generating proposal summary...');
  const summary = await generateProposalSummary(proposals, repoPrompt.content, proposedPrompt, digest);
  console.log('\n── PROPOSED CHANGES ────────────────────────────────\n');
  console.log(summary);
  console.log('\n────────────────────────────────────────────────────\n');

  progress('Opening PR');
  const requestId = randomUUID();
  const outcome = await proposePromptChange({
    requestId,
    content: proposedPrompt,
    fileSha: repoPrompt.sha,
    summary,
    proposalText: proposals,
    digest,
    patchCount: patched.applied,
    sizeCheck: check.size,
    skipped,
  });

  if (email) {
    await sendProposalEmail(summary, digest, {
      prNumber: outcome.prNumber,
      prUrl: outcome.prUrl,
      reason: outcome.error,
      skipped,
    });
  }

  return {
    ...base,
    // `changed` has always meant "this run produced a change" — it now means a
    // change was PROPOSED, never applied. Consumers log it; none of them act on
    // it, so widening the meaning here is safe and the wording follows below.
    changed: outcome.ok,
    proposed: outcome.ok,
    summary,
    requestId,
    prNumber: outcome.prNumber ?? null,
    prUrl: outcome.prUrl ?? null,
    branch: outcome.branch,
    pipelineFiled: outcome.pipelineFiled,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

// CLI entry — only when executed directly (node server/agentDesignLoop.js),
// never when imported by bb-server.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDesignLoop({ email: EMAIL, dryRun: DRY_RUN, remote: REMOTE }).catch(err => {
    console.error('[DesignLoop] Fatal error:', err);
    process.exit(1);
  });
}
