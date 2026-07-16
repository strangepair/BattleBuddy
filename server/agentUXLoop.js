/**
 * UX Design Loop — reads session transcripts and behavioral metadata, proposes
 * targeted updates to ux-design.md, and auto-applies HIGH confidence proposals
 * via surgical patches (same approach as agentDesignLoop.js).
 *
 * Runs in-process on bb-server: on demand via POST /admin/console/ux-loop/run.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { ADMIN_DATA_ROOT, buildInsightsFeedback } from './contextAgent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new Anthropic();

const STORE_DIR = process.env.CONTEXT_STORE_DIR || resolve(__dirname, 'context-store');
const TRANSCRIPT_DIR = resolve(STORE_DIR, 'session-transcripts');
const UX_DESIGN_PATH = resolve(ADMIN_DATA_ROOT, 'ux-design.md');
const UX_LOOP_RESULT_PATH = resolve(ADMIN_DATA_ROOT, 'ux-loop-last-result.json');
const UX_PROPOSALS_DIR = resolve(ADMIN_DATA_ROOT, 'ux-proposals');

const UX_DESIGN_SEED = `# BattleBuddy UX Design — Living Specification
<!-- UX_DESIGN_VERSION: v1.0 -->
Living document. Updated by the UX design loop based on real session evidence.

## Core Flow
The circuit-breaker loop: urge → open app → session (observation or resistance mode) → outcome logged.

## Voice Interaction
...

## Screen Design
...

## Friction Points & Known Issues
...

## What's Working
...

## Feature Gaps
...
`;

// ── File I/O ──────────────────────────────────────────────────────────────────

export function readUXDesign() {
  try { return readFileSync(UX_DESIGN_PATH, 'utf-8'); } catch { return UX_DESIGN_SEED; }
}

export function writeUXDesign(content) {
  mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
  writeFileSync(UX_DESIGN_PATH, content, 'utf-8');
}

export function loadUXLoopResult() {
  try { return JSON.parse(readFileSync(UX_LOOP_RESULT_PATH, 'utf-8')); } catch { return null; }
}

export function saveUXLoopResult(data) {
  mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
  const existing = loadUXLoopResult() || {};
  let history = existing.history || [];
  if (data.status === 'done' || data.status === 'error') {
    history = [{ ...data }, ...history.filter(h => h.startedAt !== data.startedAt)].slice(0, 10);
  }
  writeFileSync(UX_LOOP_RESULT_PATH, JSON.stringify({ ...data, history }, null, 2));
}

// ── Load transcripts from volume ──────────────────────────────────────────────

function loadRecentSessions(userId, { cutoffMs, limit = 10 } = {}) {
  const dir = resolve(TRANSCRIPT_DIR, userId);
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  return files.map(f => {
    try { return JSON.parse(readFileSync(resolve(dir, f), 'utf-8')); } catch { return null; }
  })
    .filter(s => s && s.updatedAt && (!cutoffMs || new Date(s.updatedAt).getTime() > cutoffMs) && (s.messages || []).length >= 3)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, limit);
}

// ── Build UX signal digest ────────────────────────────────────────────────────

async function buildUXDigest() {
  const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: WebSocket } })
    : null;

  const digest = {
    totalSessions: 0,
    totalUsers: 0,
    shortSessions: 0,      // < 3 turns — likely abandonment
    avgTurns: 0,
    voiceSessions: 0,
    helpedRate: null,
    sessionModes: {},
    appIssues: [],
    uxProposalsFromAudit: [],
    transcriptCorpus: '',
  };

  // ── Session events from Supabase (behavioral metadata) ─────────────────────
  if (supabase) {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data: sessionEvents } = await supabase
      .from('bb_events')
      .select('metadata, occurred_at')
      .eq('event_type', 'session')
      .gte('occurred_at', cutoff)
      .order('occurred_at', { ascending: false })
      .limit(300);

    let totalTurns = 0, helpedCount = 0, helpedTotal = 0;
    for (const row of sessionEvents || []) {
      const m = row.metadata || {};
      digest.totalSessions++;
      const turns = m.turn_count || 0;
      totalTurns += turns;
      if (turns < 3) digest.shortSessions++;
      if (m.voice_turns > 0 || m.modality === 'voice') digest.voiceSessions++;
      if (m.mode) digest.sessionModes[m.mode] = (digest.sessionModes[m.mode] || 0) + 1;
      if (m.helped != null) { helpedTotal++; if (m.helped) helpedCount++; }
    }
    digest.avgTurns = digest.totalSessions > 0 ? Math.round(totalTurns / digest.totalSessions) : 0;
    digest.helpedRate = helpedTotal > 0 ? Math.round((helpedCount / helpedTotal) * 100) : null;

    // ── Transcript audit reports (already have app_issues extracted) ──────────
    const { data: auditRows } = await supabase
      .from('bb_events')
      .select('metadata, occurred_at, user_id')
      .eq('event_type', 'transcript_audit')
      .order('occurred_at', { ascending: false })
      .limit(20);

    const usersSeen = new Set();
    for (const row of auditRows || []) {
      usersSeen.add(row.user_id);
      const report = row.metadata?.report || {};
      if (report.app_issues?.length) {
        digest.appIssues.push(...report.app_issues.map(i => `[${row.occurred_at.slice(0, 10)}] ${i}`));
      }
      for (const p of report.proposals || []) {
        if (/ux|ui|screen|button|tap|voice|nav|flow|session|layout|display|load|latency|design/i.test(p)) {
          digest.uxProposalsFromAudit.push(p);
        }
      }
    }
    digest.totalUsers = usersSeen.size;
  }

  // ── Raw transcripts from volume (recent sessions, all users) ─────────────
  let userDirs = [];
  try { userDirs = readdirSync(TRANSCRIPT_DIR); } catch {}

  const sinceMs = Date.now() - 14 * 24 * 3600 * 1000;
  let corpus = '';
  for (const userId of userDirs) {
    const sessions = loadRecentSessions(userId, { cutoffMs: sinceMs, limit: 8 });
    for (const s of sessions) {
      const header = `\n\n=== SESSION ${s.sessionId} (${s.updatedAt}) [${s.messageCount} messages] ===\n`;
      let excerpt = header;
      for (const m of (s.messages || [])) {
        const line = `${m.role === 'user' ? 'USER' : 'BB'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}\n`;
        if (corpus.length + excerpt.length + line.length > 60000) break;
        excerpt += line;
      }
      corpus += excerpt;
    }
    if (corpus.length > 60000) break;
  }
  digest.transcriptCorpus = corpus;

  return digest;
}

// ── Propose UX changes ────────────────────────────────────────────────────────

async function proposeUXChanges(uxDesign, digest) {
  const adminFeedback = buildInsightsFeedback();

  const sessionMetaSummary = [
    `Total sessions (last 30 days): ${digest.totalSessions}`,
    `Users: ${digest.totalUsers}`,
    `Short sessions (<3 turns, likely abandoned): ${digest.shortSessions} (${digest.totalSessions > 0 ? Math.round(digest.shortSessions / digest.totalSessions * 100) : 0}%)`,
    `Avg turns per session: ${digest.avgTurns}`,
    digest.helpedRate != null ? `User-reported "helped": ${digest.helpedRate}%` : null,
    Object.keys(digest.sessionModes).length ? `Session modes: ${Object.entries(digest.sessionModes).map(([k, v]) => `${k}=${v}`).join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are auditing the UX and product design of BattleBuddy, a mobile AI companion that acts as a real-time circuit breaker for smoking urges. You will receive:
1. The current UX design document
2. Session behavioral metadata (abandonment rate, modes, turn counts)
3. App issues spotted in recent transcript audits
4. Raw session transcript excerpts

Your job: propose specific, evidence-based improvements to the UX design document.

For each proposal:
- SECTION: which section of the UX design doc this affects (or "new section: [name]")
- CONFIDENCE: HIGH (clear repeated pattern), MEDIUM (emerging), or LOW (single instance)
- CHANGE TYPE: add / update / remove
- EVIDENCE: specific quote or metric from the data that supports this change
- PROPOSED CONTENT: exact text to add or replace in the UX doc

Focus on:
- Session abandonment — what causes users to drop out early
- Voice interaction friction (confusion, re-prompts, misunderstandings)
- Navigation and flow breakdowns spotted in transcripts
- Missing features users requested verbatim
- What's working well and should be documented / reinforced
- The core circuit-breaker flow (urge → open app → outcome) — is it working?

Be concise. One proposal per finding. Don't propose removing safety content (988 off-ramp).
${adminFeedback ? `\nAdmin verdicts on past proposals — calibrate to these:\n${adminFeedback}\n` : ''}`,
    messages: [{
      role: 'user',
      content: `## Current UX design document:
${uxDesign}

## Session behavioral metadata:
${sessionMetaSummary}

## App issues from recent transcript audits:
${digest.appIssues.length ? digest.appIssues.slice(0, 30).join('\n') : 'None logged yet.'}

## UX-relevant proposals from transcript audits:
${digest.uxProposalsFromAudit.length ? digest.uxProposalsFromAudit.slice(0, 20).join('\n') : 'None.'}

## Recent session transcripts:
${digest.transcriptCorpus || 'No transcripts available.'}

Propose specific updates to the UX design document.`,
    }],
  });

  return response.content[0].text;
}

// ── Patch-based apply to ux-design.md ────────────────────────────────────────

function parsePatchBlocks(text) {
  const patches = [];
  const re = /<<<FIND>>>\n([\s\S]*?)\n<<<REPLACE>>>\n([\s\S]*?)\n<<<END>>>/g;
  let m;
  while ((m = re.exec(text)) !== null) patches.push({ find: m[1], replace: m[2] });
  return patches;
}

async function applyProposalsToUXDesign(proposalText, currentUXDesign) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are applying HIGH confidence proposals as surgical patches to a UX design document.

For each HIGH confidence proposal, output one patch block:
<<<FIND>>>
[exact verbatim text from the current UX design doc to replace]
<<<REPLACE>>>
[updated text]
<<<END>>>

Rules:
- Only emit patches for HIGH confidence proposals. Skip MEDIUM and LOW.
- The FIND text MUST appear verbatim in the current document.
- For new content added to a section, set FIND to the last line of that section and REPLACE to that line plus new content below.
- Output ONLY patch blocks — no preamble, no explanation.
- If there are no HIGH confidence proposals, output nothing.`,
    messages: [{
      role: 'user',
      content: `## Proposals (apply HIGH confidence only):
${proposalText}

## Current UX design document:
${currentUXDesign}`,
    }],
  });

  const patches = parsePatchBlocks(response.content[0].text);
  if (patches.length === 0) return { content: currentUXDesign, applied: 0, total: 0 };

  let result = currentUXDesign;
  let applied = 0;
  for (const { find, replace } of patches) {
    if (result.includes(find)) {
      result = result.replace(find, replace);
      applied++;
    } else {
      console.warn(`[UXLoop] Patch FIND not matched: "${find.slice(0, 80).replace(/\n/g, '↵')}"`);
    }
  }
  console.log(`[UXLoop] Applied ${applied}/${patches.length} patch(es) to ux-design.md`);
  return { content: result, applied, total: patches.length };
}

function writeUXProposal(proposalText, digest) {
  mkdirSync(UX_PROPOSALS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = resolve(UX_PROPOSALS_DIR, `ux-proposal-${date}-${Date.now()}.md`);
  writeFileSync(path, `# UX Proposal — ${date}\n\nSessions: ${digest.totalSessions} | Users: ${digest.totalUsers}\n\n${proposalText}`, 'utf-8');
  return path;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runUXLoop({ trigger = 'admin_console', onProgress = null } = {}) {
  const progress = (stage) => { if (onProgress) onProgress(stage); };
  console.log(`[UXLoop] Starting UX design loop (trigger: ${trigger})...`);

  progress('Loading UX design doc');
  const currentUXDesign = readUXDesign();

  progress('Loading session signals');
  const digest = await buildUXDigest();
  console.log(`[UXLoop] Digest: ${digest.totalSessions} sessions, ${digest.appIssues.length} app issues, ${digest.transcriptCorpus.length} transcript chars`);

  progress('Analyzing UX patterns');
  const proposals = await proposeUXChanges(currentUXDesign, digest);

  const proposalPath = writeUXProposal(proposals, digest);
  console.log(`[UXLoop] Proposals written to: ${proposalPath}`);

  progress('Applying changes');
  const { content: updatedDesign, applied, total } = await applyProposalsToUXDesign(proposals, currentUXDesign);

  const changed = applied > 0;
  if (changed) {
    writeUXDesign(updatedDesign);
    console.log(`[UXLoop] ux-design.md updated (${applied}/${total} patches applied)`);
  } else {
    console.log('[UXLoop] No HIGH confidence patches applied — ux-design.md unchanged');
  }

  return {
    ok: true,
    changed,
    applied,
    total,
    sessions: digest.totalSessions,
    users: digest.totalUsers,
    proposalPath,
    proposals,
  };
}
