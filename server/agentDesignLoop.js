/**
 * Agent Design Loop — reads accumulated session data across users, proposes
 * targeted updates to agent.md, auto-applies HIGH confidence proposals to
 * system.battlebuddy.md, backs up the previous prompt, and emails a summary
 * of what was actually applied.
 *
 * Runs in TWO modes:
 *  - In-process on bb-server (production): scheduled daily from index.js and
 *    on demand via POST /admin/console/design-loop/run. Prompt changes persist
 *    via the volume prompt store (persistPromptLive); proposals land on the
 *    volume; git is skipped (the image has no git/.git/credentials). No
 *    dependence on a dev machine.
 *  - CLI on a dev machine:
 *      node server/agentDesignLoop.js [--dry-run] [--remote] [--email] [--users=id1,id2]
 *    Same flow, plus the prompt change is committed + pushed so the repo
 *    stays the source of truth.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { persistPromptLive, ADMIN_DATA_ROOT, buildInsightsFeedback, listKnownProfiles } from './contextAgent.js';

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
const BACKUPS_DIR = resolve(__dirname, 'prompts', 'backups');
// In prod the repo dirs aren't in the image / aren't durable — use the volume.
const PROPOSALS_DIR = ON_RAILWAY ? resolve(ADMIN_DATA_ROOT, 'agent-proposals') : resolve(__dirname, '..', 'agent-proposals');
const APPLIED_DIR = resolve(PROPOSALS_DIR, 'applied');

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

// ── Auto-apply HIGH confidence proposals to system prompt ─────────────────────

// Markers that MUST survive every rewrite. A full-file "return the complete
// updated prompt" rewrite can silently drop content if the model runs out of
// output tokens mid-generation — the response is truncated wherever
// generation happened to be, with no error raised. This bit us twice
// (2026-07-03 and 2026-07-04): the {{placeholder}} runtime-context block,
// the Hard limits section, and the 988 crisis off-ramp all disappeared from
// the tail of the file because the rewrite ran out of budget before reaching
// them. Checking stop_reason plus a content-marker sanity check is the only
// way to catch this — the model's own "never remove X" instruction is not
// self-enforcing.
const REQUIRED_MARKERS = [
  '{{current_goal}}', '{{profile}}', '{{life_architecture}}',
  '{{trigger_context}}', '{{relevant_memories}}', '{{recent_history}}',
  '{{session_context}}', '988', '## Hard limits',
];

function findMissingMarkers(content) {
  return REQUIRED_MARKERS.filter(marker => !content.includes(marker));
}

// Patch-based apply: ask Sonnet for <<<FIND>>>/<<<REPLACE>>>/<<<END>>> blocks
// instead of a full file rewrite. Output is ~1-2k tokens instead of ~17k, so
// this finishes in ~30s rather than timing out at 10 minutes.
function parsePatchBlocks(text) {
  const patches = [];
  const re = /<<<FIND>>>\n([\s\S]*?)\n<<<REPLACE>>>\n([\s\S]*?)\n<<<END>>>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    patches.push({ find: m[1], replace: m[2] });
  }
  return patches;
}

async function applyProposalsToSystemPrompt(proposalText, currentSystemPrompt) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are applying HIGH confidence proposals as surgical patches to a live AI system prompt.

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
      content: `## Proposals (apply HIGH confidence only):

${proposalText}

## Current system prompt:

${currentSystemPrompt}`,
    }],
  });

  const patchText = response.content[0].text;
  const patches = parsePatchBlocks(patchText);

  if (patches.length === 0) {
    console.log('[DesignLoop] Patch response contained no valid patch blocks — no HIGH confidence proposals or none matched.');
    return currentSystemPrompt;
  }

  let result = currentSystemPrompt;
  let applied = 0;
  for (const { find, replace } of patches) {
    if (result.includes(find)) {
      result = result.replace(find, replace);
      applied++;
    } else {
      console.warn(`[DesignLoop] Patch FIND text not found in system prompt (first 80 chars): "${find.slice(0, 80).replace(/\n/g, '↵')}"`);
    }
  }
  console.log(`[DesignLoop] Applied ${applied}/${patches.length} patch(es)`);

  const missing = findMissingMarkers(result);
  if (missing.length > 0) {
    throw new Error(
      `Patches would remove required markers, refusing to apply: ${missing.join(', ')}`
    );
  }

  return result;
}

// ── Summarize what was actually applied ───────────────────────────────────────

async function generateAppliedSummary(proposalText, promptBefore, promptAfter, digest) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You are writing a concise change notification email for a developer. Given proposals and before/after system prompt versions:
- List only what was actually applied (HIGH confidence proposals)
- One bullet per change, plain English, 1 sentence each
- Note how many MEDIUM/LOW proposals were skipped and will need more evidence
- End with the session count analyzed
No preamble. Clean markdown.`,
    messages: [{
      role: 'user',
      content: `PROPOSALS:\n${proposalText}\n\nSYSTEM PROMPT BEFORE (first 3000 chars):\n${promptBefore.slice(0, 3000)}\n\nSYSTEM PROMPT AFTER (first 3000 chars):\n${promptAfter.slice(0, 3000)}\n\nSessions analyzed: ${digest.totalSessions} across ${digest.totalUsers} user(s).`,
    }],
  });
  return response.content[0].text;
}

// ── File management ───────────────────────────────────────────────────────────

function backupSystemPrompt() {
  mkdirSync(BACKUPS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const backupPath = resolve(BACKUPS_DIR, `system.battlebuddy.${date}.md`);
  copyFileSync(SYSTEM_PROMPT, backupPath);
  console.log(`[DesignLoop] Backed up system prompt to: ${backupPath}`);
  return backupPath;
}

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

function archiveProposal(filepath) {
  mkdirSync(APPLIED_DIR, { recursive: true });
  const filename = filepath.split('/').pop();
  const dest = resolve(APPLIED_DIR, filename);
  writeFileSync(dest, readFileSync(filepath, 'utf-8'));
  // Overwrite original with a redirect note so old paths still make sense
  writeFileSync(filepath, `# Moved\nThis proposal was auto-applied and archived to applied/${filename}\n`);
  console.log(`[DesignLoop] Archived proposal to: ${dest}`);
}

function commitAndPush(appliedSummary) {
  try {
    const repoRoot = resolve(__dirname, '..');
    execSync('git add server/prompts/system.battlebuddy.md server/prompts/backups/', { cwd: repoRoot });
    const msg = `fix: agent design loop auto-applied HIGH confidence proposals\n\n${appliedSummary}\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`;
    // execFileSync passes `msg` as a single argv entry with no shell in
    // between, so real newlines survive intact. The previous version ran
    // this through execSync(`git commit -m ${JSON.stringify(msg)}`), which
    // handed the whole thing to `/bin/sh -c`; JSON.stringify re-escapes real
    // newlines as literal two-character "\n", and double-quoted shell args
    // don't interpret that as an escape — so commit messages landed as one
    // giant subject line with visible "\n" text instead of real paragraphs.
    execFileSync('git', ['commit', '-m', msg], { cwd: repoRoot });
    execSync('git push origin main', { cwd: repoRoot });
    console.log('[DesignLoop] Committed and pushed updated system prompt');
  } catch (e) {
    console.warn('[DesignLoop] Git commit/push failed:', e.message);
  }
}

// ── Send email ────────────────────────────────────────────────────────────────

async function sendAppliedEmail(appliedSummary, digest) {
  if (!RESEND_API_KEY) {
    console.warn('[DesignLoop] RESEND_API_KEY not set — skipping email');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = `BattleBuddy — prompt updated ${date}`;

  const html = `
<html><body style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; color: #1a1a1a; line-height: 1.6;">
  <h2 style="border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">BattleBuddy system prompt updated</h2>
  <p style="color: #6b7280; font-size: 14px;">${date} · ${digest.totalSessions} sessions analyzed · ${digest.totalUsers} user(s)</p>
  <div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 16px; margin: 20px 0; border-radius: 4px;">
    ${appliedSummary
      .replace(/^## (.+)$/gm, '<h3 style="margin-top:16px">$1</h3>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n\n/g, '</p><p>')
    }
  </div>
  <p style="color: #6b7280; font-size: 13px;">
    Changes are live on Railway. Previous prompt backed up to <code>prompts/backups/</code> for rollback if needed.
  </p>
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
      text: appliedSummary,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn(`[DesignLoop] Email failed: ${res.status} ${err}`);
  } else {
    console.log(`[DesignLoop] Applied changes email sent to ${EMAIL_TO}`);
  }
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

  progress('Applying changes');
  console.log('[DesignLoop] Auto-applying HIGH confidence proposals to system prompt...');
  const systemPromptAfter = await applyProposalsToSystemPrompt(proposals, systemPromptBefore);

  const changed = systemPromptAfter.trim() !== systemPromptBefore.trim();
  if (!changed) {
    console.log('[DesignLoop] No changes to apply — system prompt unchanged');
    return { ok: true, changed: false, proposalPath, users: digest.totalUsers, sessions: digest.totalSessions };
  }

  const systemPromptVersioned = bumpPromptVersion(systemPromptAfter);
  if (ON_RAILWAY) {
    // Container write + volume mirror + backup: live on the next turn and
    // survives redeploys until the repo ships a different prompt.
    persistPromptLive(systemPromptVersioned);
  } else {
    backupSystemPrompt();
    writeFileSync(SYSTEM_PROMPT, systemPromptVersioned);
  }
  console.log('[DesignLoop] System prompt updated');

  archiveProposal(proposalPath);

  console.log('[DesignLoop] Generating applied changes summary...');
  const appliedSummary = await generateAppliedSummary(proposals, systemPromptBefore, systemPromptAfter, digest);
  console.log('\n── APPLIED CHANGES ─────────────────────────────────\n');
  console.log(appliedSummary);
  console.log('\n────────────────────────────────────────────────────\n');

  if (ON_RAILWAY) {
    console.log('[DesignLoop] Prod run — prompt persisted to the volume; fold into git from a dev session when convenient.');
  } else {
    commitAndPush(appliedSummary);
  }

  if (email) {
    await sendAppliedEmail(appliedSummary, digest);
  }

  return { ok: true, changed: true, proposalPath, summary: appliedSummary, users: digest.totalUsers, sessions: digest.totalSessions };
}

// CLI entry — only when executed directly (node server/agentDesignLoop.js),
// never when imported by bb-server.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDesignLoop({ email: EMAIL, dryRun: DRY_RUN, remote: REMOTE }).catch(err => {
    console.error('[DesignLoop] Fatal error:', err);
    process.exit(1);
  });
}
