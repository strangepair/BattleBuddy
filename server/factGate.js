/**
 * The merge gate — write discipline for the canonical fact store.
 *
 * Every fact proposal (extraction shadow writes now; agent tools in Phase 3)
 * passes through here and gets exactly one verdict:
 *
 *   NEW        — no active fact covers this; insert under a fresh key
 *   DUPLICATE  — an active fact already says this; strengthen, never append
 *   SUPERSEDES — same subject, new truth; chain the old row out of the prompt
 *   CONFLICTS  — same subject, incompatible truths; both stay, flagged, and
 *                the agent's next natural opening resolves it in conversation
 *   REJECT     — ungrounded, speculative, or not a fact about this person
 *
 * Split the same way as promotionJob: the judgment call is one batched Haiku
 * call (runGate), everything that must not be probabilistic is pure and
 * tested — grounding (buildVerdictPlan rejects anything without evidence
 * before the LLM ever sees it) and precedence (a lower tier never
 * auto-supersedes a higher one; it files CONFLICTS instead).
 *
 * Fail-closed contract: any LLM/parse/validation failure produces zero
 * writes. A bad cycle can lose one cycle's proposals, never stored truth.
 *
 * Design: docs/11-MEMORY-ARCHITECTURE.md §3.5; plan: docs/12 PR 2.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { ADMIN_DATA_ROOT } from './contextAgent.js';
import {
  KEY_PATTERN, slugifyKey, ensureUniqueKey,
  getActiveFacts, insertFact, strengthenFact, supersedeFact, flagConflict,
} from './factStore.js';

export const GATE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Precedence tiers (spec §3.5): user_edited > user_stated/agent_tool >
 * consolidation (ledger-derived) > extraction/backfill. Cross-tier downward
 * never auto-supersedes.
 */
export const SOURCE_TIER = {
  user_edited: 4,
  user_stated: 3,
  agent_tool: 3,
  consolidation: 2,
  extraction: 1,
  backfill: 1,
};

// ─── Grounding (pure) ───────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'they',
  'their', 'them', 'his', 'her', 'he', 'she', 'it', 'its', 'this', 'that',
  'has', 'have', 'had', 'not', 'no', 'do', 'does', 'did', 'user', 'i', 'my', 'me', 'you',
]);

function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

export const GROUNDING_MIN_OVERLAP = 0.25;

/**
 * Find the user utterance that grounds a proposal: the message sharing the
 * largest fraction of the proposal's content words. Below the threshold the
 * proposal is ungrounded — this is the anti-fabrication invariant applied
 * mechanically, before any LLM judgment.
 *
 * @returns {{quote: string, overlap: number} | null}
 */
export function findGroundingQuote(statement, messages) {
  const words = contentWords(statement);
  if (!words.length) return null;

  let best = null;
  for (const m of messages || []) {
    if (m.role !== 'user' || !m.content) continue;
    const msgWords = new Set(contentWords(m.content));
    const hits = words.filter(w => msgWords.has(w)).length;
    const overlap = hits / words.length;
    if (overlap >= GROUNDING_MIN_OVERLAP && (!best || overlap > best.overlap)) {
      best = { quote: String(m.content).slice(0, 240), overlap };
    }
  }
  return best;
}

/**
 * Split proposals into grounded (evidence carries a quote) and ungrounded.
 * A proposal that already carries a quote (agent_tool's user_words, the
 * Sonnet backfill) passes as-is; otherwise a quote is searched for in the
 * conversation window.
 */
export function groundProposals(proposals, messages) {
  const grounded = [];
  const ungrounded = [];
  for (const p of proposals || []) {
    const existingQuote = (p.evidence || []).find(e => e?.quote && String(e.quote).trim().length >= 5);
    if (existingQuote) {
      grounded.push(p);
      continue;
    }
    const found = findGroundingQuote(p.value, messages);
    if (found) {
      grounded.push({ ...p, evidence: [...(p.evidence || []), { quote: found.quote }] });
    } else {
      ungrounded.push(p);
    }
  }
  return { grounded, ungrounded };
}

// ─── Verdict plan (pure) ────────────────────────────────────────────────────

/**
 * Turn raw LLM verdicts into an executable operation plan, enforcing the
 * invariants the LLM is not trusted with:
 *
 * - key discipline: referenced keys must exist and be active; new keys must
 *   be well-formed and category-prefixed. Violations become REJECT, never a
 *   guessed write.
 * - precedence: SUPERSEDES from a lower tier against a higher-tier fact —
 *   or against a user-confirmed fact — downgrades to CONFLICTS.
 * - one verdict per proposal; a proposal the LLM skipped is REJECTed
 *   (fail closed), never silently dropped from the log.
 *
 * @param {Array} proposals - grounded proposals, each {category, value, detail?, evidence, source, confidence?}
 * @param {Array} rawVerdicts - LLM output [{index, verdict, key?, reason?}]
 * @param {Array} activeFacts - current active fact rows
 * @returns {Array<{op, proposal, key?, targetId?, reason}>}
 */
export function buildVerdictPlan(proposals, rawVerdicts, activeFacts) {
  const activeByKey = new Map(activeFacts.map(f => [f.key, f]));
  const usedKeys = new Set(activeFacts.map(f => f.key));
  const byIndex = new Map();
  for (const v of Array.isArray(rawVerdicts) ? rawVerdicts : []) {
    if (Number.isInteger(v?.index) && !byIndex.has(v.index)) byIndex.set(v.index, v);
  }

  const plan = [];
  proposals.forEach((proposal, i) => {
    const v = byIndex.get(i);
    const reject = reason => plan.push({ op: 'reject', proposal, reason });
    if (!v || typeof v.verdict !== 'string') return reject('no verdict returned — fail closed');

    const verdict = v.verdict.toUpperCase();
    const tier = SOURCE_TIER[proposal.source] || 1;

    if (verdict === 'REJECT') return reject(v.reason || 'gate rejected');

    if (verdict === 'NEW') {
      let key = typeof v.key === 'string' ? v.key : slugifyKey(proposal.category, proposal.value);
      if (!KEY_PATTERN.test(key) || !key.startsWith(`${proposal.category}.`)) {
        key = slugifyKey(proposal.category, proposal.value);
      }
      if (activeByKey.has(key)) {
        // "New" under an occupied key is a duplicate wearing a lanyard.
        return plan.push({ op: 'strengthen', proposal, key, reason: 'NEW downgraded — key already active' });
      }
      key = ensureUniqueKey(usedKeys, key);
      usedKeys.add(key);
      return plan.push({ op: 'insert', proposal, key, reason: v.reason || 'new fact' });
    }

    // The remaining verdicts all reference an existing active key.
    const target = activeByKey.get(v.key);
    if (!target) return reject(`${verdict} referenced unknown/inactive key '${v.key}'`);
    if (target.category !== proposal.category) return reject(`${verdict} crossed categories (${target.category} vs ${proposal.category})`);

    if (verdict === 'DUPLICATE') {
      return plan.push({ op: 'strengthen', proposal, key: target.key, reason: v.reason || 'duplicate' });
    }

    if (verdict === 'SUPERSEDES') {
      const targetTier = SOURCE_TIER[target.source] || 1;
      const downgrade = tier < targetTier
        || (target.confidence === 'confirmed' && tier <= SOURCE_TIER.extraction);
      if (downgrade) {
        return plan.push({
          op: 'conflict', proposal, key: target.key, targetId: target.id,
          reason: `supersede downgraded — '${target.key}' outranks ${proposal.source} (${target.source}/${target.confidence})`,
        });
      }
      return plan.push({ op: 'supersede', proposal, key: target.key, targetId: target.id, reason: v.reason || 'newer truth' });
    }

    if (verdict === 'CONFLICTS') {
      return plan.push({ op: 'conflict', proposal, key: target.key, targetId: target.id, reason: v.reason || 'incompatible truths' });
    }

    return reject(`unknown verdict '${v.verdict}'`);
  });

  return plan;
}

// ─── LLM half ───────────────────────────────────────────────────────────────

export function buildGatePrompt(proposals, activeFacts) {
  const factLines = activeFacts.length
    ? activeFacts.map(f => `- ${f.key} [${f.source}/${f.confidence}]: ${f.value}`).join('\n')
    : '(none yet)';
  const proposalLines = proposals
    .map((p, i) => `${i}. [${p.category}] ${p.value}${p.detail ? ` | detail: ${JSON.stringify(p.detail)}` : ''}`)
    .join('\n');

  return `You are the write gate for a canonical memory store about one person — a user of a quit-smoking companion. Precision matters more than recall: a wrong fact in this store erodes trust more than a missing one.

ACTIVE FACTS (the current truth, keyed):
${factLines}

PROPOSALS (candidate new facts from this conversation):
${proposalLines}

For EACH proposal, output exactly one verdict:
- "NEW" — no active fact covers this subject. Provide "key": a fresh slug in the form category.short-kebab-slug (must start with the proposal's category, must not reuse an existing key).
- "DUPLICATE" — an active fact already states this truth, even if worded differently. Provide "key" of that fact.
- "SUPERSEDES" — same subject as an active fact, but the truth has changed (e.g. "down to 3/day" replacing "smokes 8/day"). Provide "key" of the fact being replaced.
- "CONFLICTS" — same subject as an active fact, incompatible truths, and you cannot tell which is current. Provide "key". When torn between SUPERSEDES and CONFLICTS, choose CONFLICTS — asking one clarifying question later is cheaper than deleting a truth.
- "REJECT" — speculation, therapy-style inference, the assistant's idea rather than the user's reality, a countable statistic (those live in the event ledger), or too vague to be a fact.

Return ONLY a JSON array, one entry per proposal:
[{"index": 0, "verdict": "NEW", "key": "trigger.example", "reason": "short"}]`;
}

export function parseGateResponse(text) {
  // Only an array of verdicts counts. jsonrepair happily coerces prose into a
  // JSON *string* ("I cannot..."), so shape-check every branch — anything
  // that isn't an array returns null and the caller fails closed.
  const asArray = v => (Array.isArray(v) ? v : null);
  try { const v = asArray(JSON.parse(text)); if (v) return v; } catch {}
  try { const v = asArray(JSON.parse(jsonrepair(text))); if (v) return v; } catch {}
  const m = String(text).match(/\[[\s\S]*\]/);
  if (m) {
    try { const v = asArray(JSON.parse(jsonrepair(m[0]))); if (v) return v; } catch {}
  }
  return null;
}

// ─── Gate log (volume JSONL, admin-reviewable) ──────────────────────────────

const GATE_LOG_PATH = resolve(ADMIN_DATA_ROOT, 'fact-gate-log.jsonl');
const GATE_LOG_MAX_BYTES = 5 * 1024 * 1024;

function appendGateLog(entry) {
  try {
    mkdirSync(ADMIN_DATA_ROOT, { recursive: true });
    try {
      if (statSync(GATE_LOG_PATH).size > GATE_LOG_MAX_BYTES) {
        renameSync(GATE_LOG_PATH, `${GATE_LOG_PATH}.1`);
      }
    } catch {}
    appendFileSync(GATE_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[FactGate] Log append failed:', e.message);
  }
}

export function readGateLog(limit = 50) {
  try {
    const lines = readFileSync(GATE_LOG_PATH, 'utf-8').trim().split('\n');
    return lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * One gate cycle: ground → judge → plan → execute → log.
 *
 * Runs strictly off the hot path (called from analyzeAndUpdate's .then()).
 * Returns a summary for logging/tests. Every failure path is a no-op on the
 * store.
 *
 * @param {object} deps - { client } (Anthropic client), injected for tests
 */
export async function runGateCycle(rawUserId, proposals, messages, { client, sessionId = null } = {}) {
  const summary = { userId: rawUserId, sessionId, proposed: proposals?.length || 0, applied: {}, rejected: 0, ungrounded: 0 };
  if (!proposals?.length) return summary;

  const { grounded, ungrounded } = groundProposals(proposals, messages);
  summary.ungrounded = ungrounded.length;
  if (!grounded.length) {
    appendGateLog({ ts: new Date().toISOString(), ...summary, note: 'nothing grounded' });
    return summary;
  }

  const activeFacts = await getActiveFacts(rawUserId);
  const touched = new Set(grounded.map(p => p.category));
  const relevantFacts = activeFacts.filter(f => touched.has(f.category));

  let rawVerdicts = null;
  try {
    const response = await client.messages.create({
      model: GATE_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: buildGatePrompt(grounded, relevantFacts) }],
    });
    rawVerdicts = parseGateResponse(response.content[0]?.text || '');
  } catch (e) {
    console.error('[FactGate] Gate call failed (cycle skipped, no writes):', e.message);
  }
  if (!rawVerdicts) {
    appendGateLog({ ts: new Date().toISOString(), ...summary, note: 'gate call/parse failed — no writes' });
    return summary;
  }

  const plan = buildVerdictPlan(grounded, rawVerdicts, relevantFacts);
  const logOps = [];

  for (const step of plan) {
    const { op, proposal, key, targetId, reason } = step;
    const evidenceEntry = { ...(proposal.evidence?.[0] || {}), session_id: sessionId, date: new Date().toISOString().slice(0, 10) };
    try {
      if (op === 'insert') {
        await insertFact(rawUserId, {
          category: proposal.category, key, value: proposal.value, detail: proposal.detail,
          status: 'active', confidence: proposal.confidence || 'tentative',
          source: proposal.source, evidence: [evidenceEntry],
        });
      } else if (op === 'strengthen') {
        await strengthenFact(rawUserId, key, evidenceEntry);
      } else if (op === 'supersede') {
        await supersedeFact(rawUserId, key, {
          category: proposal.category, value: proposal.value, detail: proposal.detail,
          confidence: proposal.confidence || 'tentative', source: proposal.source, evidence: [evidenceEntry],
        });
      } else if (op === 'conflict') {
        const inserted = await insertFact(rawUserId, {
          category: proposal.category,
          key: ensureUniqueKey(new Set([...relevantFacts.map(f => f.key)]), `${key}-conflict`),
          value: proposal.value, detail: proposal.detail, status: 'active',
          confidence: proposal.confidence || 'tentative', source: proposal.source,
          evidence: [evidenceEntry],
        });
        if (inserted && targetId) await flagConflict(rawUserId, inserted.id, targetId);
      } else {
        summary.rejected++;
      }
      summary.applied[op] = (summary.applied[op] || 0) + (op === 'reject' ? 0 : 1);
      logOps.push({ op, key: key || null, value: proposal.value.slice(0, 100), reason });
    } catch (e) {
      console.error(`[FactGate] ${op} failed for '${key}':`, e.message);
      logOps.push({ op: `${op}-failed`, key: key || null, error: e.message });
    }
  }

  appendGateLog({ ts: new Date().toISOString(), ...summary, ops: logOps });
  return summary;
}
