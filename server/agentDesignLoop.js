/**
 * Agent Design Loop — reads accumulated session data across users and proposes
 * targeted, diff-style edits to agent.md.
 *
 * Never auto-applies changes. Writes a proposal file for human review.
 * Run manually or on a nightly schedule.
 *
 * Usage:
 *   node server/agentDesignLoop.js [--dry-run] [--users user1,user2]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

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

const STORE_DIR = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
const AGENT_MD = resolve(__dirname, '..', 'agent.md');
const PROPOSALS_DIR = resolve(__dirname, '..', 'agent-proposals');

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
  const res = await fetch(`${REMOTE_BASE_URL}/context/profile/${userId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${userId}`);
  const data = await res.json();
  return data.profile || data;
}

async function loadAllProfiles() {
  if (REMOTE) {
    // Pull known user IDs from local store filenames, fetch data from production API
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

  // Local mode
  const files = readdirSync(STORE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('default'));
  const profiles = [];
  for (const file of files) {
    const userId = file.replace('.json', '');
    if (userFilter && !userFilter.includes(userId)) continue;
    try {
      const raw = JSON.parse(readFileSync(resolve(STORE_DIR, file), 'utf-8'));
      profiles.push({ userId, ...raw });
    } catch {
      console.warn(`[DesignLoop] Could not parse ${file}, skipping`);
    }
  }
  return profiles;
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
    userLanguage: [],
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

    // Pull unknowns as open design questions
    digest.openDesignQuestions.push(...take(p.unknowns, 5));
  }

  return digest;
}

// ── Run the meta-agent ────────────────────────────────────────────────────────

async function proposeDesignUpdates(agentMd, digest) {
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
- Format each proposal as a clearly labeled diff block: SECTION, CHANGE TYPE (add/update/remove), and the proposed content.
- Rate each proposal: HIGH (clear evidence), MEDIUM (pattern emerging), LOW (single instance, worth watching).

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

Propose specific updates to agent.md. For each proposal, include:
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

// ── Generate change report ────────────────────────────────────────────────────

async function generateChangeReport(proposalText, agentMdBefore, agentMdAfter, digest) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You are a concise technical writer. Given a set of proposed changes and before/after versions of a design document,
write a short change report (under 300 words) summarizing:
1. How many proposals were in total, broken down by HIGH/MEDIUM/LOW confidence
2. A bullet list of what actually changed in the document (inferred from before/after diff)
3. What was left as open questions or deferred
Format it as clean markdown, no preamble.`,
    messages: [{
      role: 'user',
      content: `PROPOSALS:\n${proposalText}\n\nAGENT.MD BEFORE (first 2000 chars):\n${agentMdBefore.slice(0, 2000)}\n\nAGENT.MD AFTER (first 2000 chars):\n${agentMdAfter.slice(0, 2000)}\n\nSessions analyzed: ${digest.totalSessions} across ${digest.totalUsers} user(s).`,
    }],
  });
  return response.content[0].text;
}

// ── Write proposal file ───────────────────────────────────────────────────────

function writeProposal(proposalText, digest) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `proposal-${timestamp}.md`;
  const filepath = resolve(PROPOSALS_DIR, filename);

  try { mkdirSync(PROPOSALS_DIR, { recursive: true }); } catch {}

  const content = `# agent.md Update Proposal — ${new Date().toISOString().slice(0, 10)}

Generated by: agent design loop
Users analyzed: ${digest.totalUsers}
Total sessions: ${digest.totalSessions}

---

## Review instructions

Each proposal below is labeled HIGH / MEDIUM / LOW confidence.
- HIGH: apply directly if it looks right
- MEDIUM: review carefully, may need tuning
- LOW: watch for more evidence before applying

To apply: edit agent.md directly, then add an entry to the Design Update Log at the bottom.
To reject: leave the proposal file as-is or delete it.

---

${proposalText}
`;

  writeFileSync(filepath, content);
  return filepath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[DesignLoop] Starting agent design loop...');

  if (!existsSync(AGENT_MD)) {
    console.error('[DesignLoop] agent.md not found at', AGENT_MD);
    process.exit(1);
  }

  const agentMd = readFileSync(AGENT_MD, 'utf-8');
  console.log(`[DesignLoop] Loaded agent.md (${agentMd.length} chars)`);

  const profiles = await loadAllProfiles();
  if (profiles.length === 0) {
    console.error('[DesignLoop] No user profiles found in', STORE_DIR);
    process.exit(1);
  }
  console.log(`[DesignLoop] Loaded ${profiles.length} user profile(s)`);

  const digest = buildSignalDigest(profiles);
  console.log(`[DesignLoop] Signal digest: ${digest.totalSessions} sessions, ${digest.whatWorks.length} what-works signals, ${digest.whatDoesntWork.length} what-doesnt-work signals`);

  if (DRY_RUN) {
    console.log('[DesignLoop] DRY RUN — digest built, skipping LLM call');
    console.log(JSON.stringify(digest, null, 2));
    return;
  }

  console.log('[DesignLoop] Calling Sonnet to analyze and propose updates...');
  const proposal = await proposeDesignUpdates(agentMd, digest);

  const filepath = writeProposal(proposal, digest);
  console.log(`[DesignLoop] Proposal written to: ${filepath}`);

  // Read agent.md again after any manual edits (in automated mode, same as before)
  const agentMdAfter = existsSync(AGENT_MD) ? readFileSync(AGENT_MD, 'utf-8') : agentMd;

  console.log('[DesignLoop] Generating change report...');
  const report = await generateChangeReport(proposal, agentMd, agentMdAfter, digest);

  const reportPath = filepath.replace('proposal-', 'report-').replace('.md', '-report.md');
  writeFileSync(reportPath, `# Agent Design Loop — Change Report\n${new Date().toISOString().slice(0, 10)}\n\n${report}\n\n---\n\n[Full proposal](${filepath.split('/').pop()})\n`);
  console.log(`[DesignLoop] Change report written to: ${reportPath}`);
  console.log('\n── CHANGE REPORT ──────────────────────────────────\n');
  console.log(report);
  console.log('\n────────────────────────────────────────────────────\n');
  console.log('[DesignLoop] Review the proposal, then apply accepted changes to agent.md manually.');

  if (EMAIL) {
    const reportText = readFileSync(reportPath, 'utf-8');
    await sendEmailReport(reportText, filepath, digest);
  }
}

// ── Send email report ─────────────────────────────────────────────────────────

async function sendEmailReport(reportText, proposalPath, digest) {
  if (!RESEND_API_KEY) {
    console.warn('[DesignLoop] RESEND_API_KEY not set — skipping email');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = `BattleBuddy Design Loop — ${date}`;

  // Convert markdown report to simple HTML
  const html = `
<html><body style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; color: #1a1a1a; line-height: 1.6;">
  <h2 style="border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">🧠 BattleBuddy Agent Design Loop</h2>
  <p style="color: #6b7280; font-size: 14px;">${date} · ${digest.totalSessions} sessions · ${digest.totalUsers} user(s)</p>
  <div style="background: #f9fafb; border-left: 4px solid #3b82f6; padding: 16px; margin: 20px 0; border-radius: 4px;">
    ${reportText
      .replace(/^## (.+)$/gm, '<h3 style="margin-top:16px">$1</h3>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[hlip])/gm, '')
    }
  </div>
  <p style="color: #6b7280; font-size: 13px;">
    Proposal file: <code>${proposalPath}</code><br>
    To apply changes: open agent.md and apply the HIGH confidence proposals you want, then redeploy.
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
      text: reportText,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn(`[DesignLoop] Email failed: ${res.status} ${err}`);
  } else {
    console.log(`[DesignLoop] Email sent to ${EMAIL_TO}`);
  }
}

main().catch(err => {
  console.error('[DesignLoop] Fatal error:', err);
  process.exit(1);
});
