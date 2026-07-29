/**
 * Backfill — derives canonical fact proposals from the existing profile blob
 * (deterministic, no LLM) plus a Sonnet pass over the unstructured remainder.
 *
 * Everything lands as status='proposed', source='backfill'. Nothing activates
 * without human review — Phase 0 exits with Mike auditing his own generated
 * memory document (docs/12-MEMORY-IMPL-PLAN.md, stop-point b).
 *
 * The deterministic mapping is pure (profile in, proposals out) so the exact
 * translation is testable; only the Sonnet pass and the insert loop touch the
 * network.
 */

import { slugifyKey, ensureUniqueKey, FACT_CATEGORIES, KEY_PATTERN } from './factStore.js';

const itemValue = item =>
  typeof item === 'string' ? item : (item && typeof item === 'object' && item.value) || '';
const itemCapturedAt = item =>
  (item && typeof item === 'object' && item.captured_at) || null;

/**
 * Deterministic pass: structured profile fields → fact proposals.
 *
 * Deliberately mechanical (spec Phase 0: "scalars and structured arrays
 * translate mechanically"). The unstructured remainder — life_context,
 * user_quotes, unknowns→watch nuance, emotional_patterns, session_history
 * person-facts — is the Sonnet pass's job, not this one's.
 *
 * voice_preference is deliberately NOT derived: it's app state, which is
 * exactly what stays in user_profiles after Phase 4.
 *
 * @returns {Array<{category,key,value,detail,confidence,evidence}>}
 */
export function deriveFactsFromProfile(profile) {
  const proposals = [];
  const keys = new Set();

  const push = (category, keyHint, value, { detail, confidence, evidence } = {}) => {
    if (!value) return null;
    const base = KEY_PATTERN.test(keyHint) ? keyHint : slugifyKey(category, keyHint);
    // Identical slug within one derivation = same underlying fact restated —
    // merge evidence rather than minting a rival (near-dupes across *different*
    // wordings are the audit's and consolidation's job).
    const existing = proposals.find(p => p.key === base);
    if (existing && existing.category === category) {
      if (evidence) existing.evidence.push(...evidence);
      if (detail) existing.detail = { ...(existing.detail || {}), ...detail };
      return existing;
    }
    const key = ensureUniqueKey(keys, base);
    keys.add(key);
    const proposal = {
      category,
      key,
      value: String(value),
      detail: detail || null,
      confidence: confidence || 'tentative',
      evidence: evidence || [],
    };
    proposals.push(proposal);
    return proposal;
  };

  const scalarEvidence = field => [{
    source_field: field,
    date: (profile[`${field}_updated_at`] || profile.last_updated || '').slice(0, 10) || null,
  }];
  const arrayEvidence = (field, item) => [{
    source_field: field,
    date: (itemCapturedAt(item) || '').slice(0, 10) || null,
  }];

  // identity.*
  if (profile.name) push('identity', 'identity.name', `Their name is ${profile.name}.`, { evidence: scalarEvidence('name') });
  if (profile.age) push('identity', 'identity.age', `Age: ${profile.age}.`, { evidence: scalarEvidence('age') });
  if (profile.location) push('identity', 'identity.location', `Lives in ${profile.location}.`, { evidence: scalarEvidence('location') });
  if (profile.occupation) push('identity', 'identity.occupation', `Occupation: ${profile.occupation}.`, { evidence: scalarEvidence('occupation') });
  if (profile.family) push('identity', 'identity.family', `Family: ${profile.family}.`, { evidence: scalarEvidence('family') });

  // quit.*
  if (profile.addiction_type) push('quit', 'quit.substance', `Quitting ${profile.addiction_type}.`, { evidence: scalarEvidence('addiction_type') });
  if (profile.substance_history) push('quit', 'quit.history', String(profile.substance_history), { evidence: scalarEvidence('substance_history') });
  if (profile.daily_usage) push('quit', 'quit.usage', `Current usage: ${profile.daily_usage}.`, { evidence: scalarEvidence('daily_usage') });
  if (profile.quit_reason) push('quit', 'quit.reason', String(profile.quit_reason), { evidence: scalarEvidence('quit_reason') });
  if (profile.health_concerns) push('quit', 'quit.health', String(profile.health_concerns), { evidence: scalarEvidence('health_concerns') });
  if (profile.previous_quit_attempts) push('quit', 'quit.past-attempts', String(profile.previous_quit_attempts), { evidence: scalarEvidence('previous_quit_attempts') });
  if (profile.longest_quit) push('quit', 'quit.longest-quit', `Longest quit: ${profile.longest_quit}.`, { evidence: scalarEvidence('longest_quit') });

  // trigger.* — flat triggers plus the richer taxonomy
  for (const item of profile.triggers || []) {
    const val = itemValue(item);
    if (val) push('trigger', slugifyKey('trigger', val), val, { evidence: arrayEvidence('triggers', item) });
  }
  for (const t of profile.life_architecture?.trigger_taxonomy || []) {
    const label = t?.trigger || itemValue(t);
    if (!label) continue;
    push('trigger', slugifyKey('trigger', label), label, {
      detail: {
        ...(t.context ? { context: t.context } : {}),
        ...(t.intensity ? { intensity: t.intensity } : {}),
      },
      confidence: t.verified ? 'confirmed' : 'tentative',
      evidence: [{ source_field: 'life_architecture.trigger_taxonomy', date: null }],
    });
  }

  // window.* — risk_windows is the superset (vulnerability_windows are synced
  // into it by syncVulnerabilityWindowsToRiskWindows), so derive from it and
  // enrich with the matching vulnerability window's reason/confidence.
  for (const rw of profile.risk_windows || []) {
    if (typeof rw?.hour !== 'number') continue;
    const dowName = typeof rw.day_of_week === 'number'
      ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][rw.day_of_week]
      : null;
    const key = `window.${dowName ? `${dowName}-` : ''}${rw.hour}h`;
    const clock = rw.hour === 0 ? '12am' : rw.hour < 12 ? `${rw.hour}am` : rw.hour === 12 ? '12pm' : `${rw.hour - 12}pm`;
    const vw = (profile.schedule_model?.vulnerability_windows || []).find(v => {
      const m = (v.time || '').match(/^(\d{1,2}):/);
      return m && parseInt(m[1], 10) === rw.hour;
    });
    push('window', key,
      `High-risk time: ${dowName ? dowName + ' ' : ''}around ${clock}${rw.source ? ` — ${rw.source}` : ''}.`,
      {
        detail: {
          hour: rw.hour,
          ...(typeof rw.day_of_week === 'number' ? { day_of_week: rw.day_of_week } : {}),
          ...(typeof rw.weight === 'number' ? { weight: rw.weight } : {}),
          ...(vw?.reason ? { reason: vw.reason } : {}),
        },
        confidence: vw?.confidence === 'confirmed' || (rw.weight || 0) >= 0.8 ? 'observed' : 'tentative',
        evidence: [{ source_field: 'risk_windows', date: (rw.captured_at || '').slice(0, 10) || null }],
      });
  }

  // routine.*
  for (const rb of profile.schedule_model?.routine_blocks || []) {
    if (!rb?.label) continue;
    push('routine', slugifyKey('routine', rb.label),
      `${rb.label} — ${rb.protects ? 'protective routine' : 'risk routine'}.`,
      {
        detail: { protects: !!rb.protects },
        confidence: rb.confidence === 'confirmed' ? 'confirmed' : 'tentative',
        evidence: [{ source_field: 'schedule_model.routine_blocks', session_id: rb.source_session || null }],
      });
  }

  // coping.* — one row holds the whole verdict. Later-captured entries win the
  // effectiveness call when the same strategy appears in both camps.
  const copingSources = [
    ['coping_strategies', 'untested'],
    ['what_works', 'working'],
    ['resistance_strategies', 'working'],
    ['what_doesnt_work', 'failed'],
  ];
  const copingSeen = new Map(); // key -> {proposal, capturedAt}
  for (const [field, effectiveness] of copingSources) {
    const items = field === 'resistance_strategies'
      ? profile.life_architecture?.resistance_strategies || []
      : profile[field] || [];
    for (const item of items) {
      const val = itemValue(item);
      if (!val) continue;
      const key = slugifyKey('coping', val);
      const capturedAt = itemCapturedAt(item) || '';
      const prior = copingSeen.get(key);
      if (prior) {
        prior.proposal.evidence.push(...arrayEvidence(field, item));
        // Newest capture decides effectiveness; 'untested' never overrides a verdict.
        if (effectiveness !== 'untested' && capturedAt >= prior.capturedAt) {
          prior.proposal.detail = { ...(prior.proposal.detail || {}), effectiveness };
          prior.capturedAt = capturedAt;
        }
        continue;
      }
      const proposal = push('coping', key, val, {
        detail: { effectiveness },
        evidence: arrayEvidence(field, item),
      });
      if (proposal) copingSeen.set(key, { proposal, capturedAt });
    }
  }

  // motivation.* — durable, their words
  for (const item of profile.motivations || []) {
    const val = itemValue(item);
    if (val) push('motivation', slugifyKey('motivation', val), val, { evidence: arrayEvidence('motivations', item) });
  }

  // watch.* — life changes in flight + open unknowns
  for (const w of profile.schedule_model?.life_change_watch || []) {
    const note = typeof w === 'string' ? w : w?.note;
    if (!note) continue;
    push('watch', slugifyKey('watch', note), note, {
      confidence: (typeof w === 'object' && w.confidence === 'confirmed') ? 'confirmed' : 'tentative',
      evidence: [{ source_field: 'schedule_model.life_change_watch' }],
    });
  }
  for (const item of profile.unknowns || []) {
    const val = itemValue(item);
    if (val) {
      push('watch', slugifyKey('watch', val), `Open thread they mentioned but never explained: ${val}`, {
        evidence: arrayEvidence('unknowns', item),
      });
    }
  }

  // preference.*
  if (profile.preferred_coping_style) {
    push('preference', 'preference.coping-style', `Preferred coping style: ${profile.preferred_coping_style}.`, { evidence: scalarEvidence('preferred_coping_style') });
  }
  if (profile.response_preference) {
    push('preference', 'preference.response-style', `Response preference: ${profile.response_preference}.`, { evidence: scalarEvidence('response_preference') });
  }

  return proposals;
}

/**
 * Prompt for the Sonnet pass over what the deterministic mapping can't
 * classify. Every proposal must carry a verbatim grounding quote — the
 * anti-fabrication invariant applies to the backfill too; proposals without
 * one are dropped by the caller.
 */
export function buildSonnetBackfillPrompt({ profile, memories, existingProposals }) {
  const remainder = {
    life_context: (profile.life_context || []).map(itemValue),
    user_quotes: (profile.user_quotes || []).map(itemValue),
    emotional_patterns: profile.emotional_patterns || null,
    recent_insights: (profile.recent_insights || []).map(itemValue),
    session_history: (profile.session_history || [])
      .filter(s => !s.gap && !s.boundary)
      .map(s => `${s.date}: ${s.summary} ${s.key_moments ? s.key_moments.join('; ') : ''}`),
  };
  const memoryLines = (memories || [])
    .map(m => `[${(m.created_at || '').slice(0, 10)}] (${m.type}) ${m.content}`)
    .join('\n');

  return `You are backfilling a canonical fact store for BattleBuddy, a quit-smoking companion. Below is unstructured profile material and distilled memory entries for one user. Extract durable FACTS about the person that a companion must never get wrong.

Categories (use exactly these): ${FACT_CATEGORIES.join(', ')}.
- person: people who matter, with the one-line context that prevents wrong assertions (e.g. "Alec: friend; does NOT have a Chantix prescription").
- watch: life changes in flight (new job, travel, stressors).
- Use other categories only for clear facts the structured mapping would have missed.

Rules:
- Every fact MUST include a "quote" — the verbatim source line from the material below that grounds it. No quote, no fact.
- One plain-language sentence per fact, the user's words where possible.
- Do NOT restate these already-derived facts: ${(existingProposals || []).map(p => p.key).join(', ') || '(none)'}.
- Prefer too few over wrong. Skip speculation, therapy-style inference, and anything countable (counts live in the event ledger).

UNSTRUCTURED PROFILE MATERIAL:
${JSON.stringify(remainder, null, 2)}

DISTILLED MEMORY ENTRIES:
${memoryLines || '(none)'}

Return ONLY a JSON array: [{"category": "...", "statement": "...", "quote": "...", "date": "YYYY-MM-DD or null", "detail": {} or null}]`;
}

/**
 * Parse + ground the Sonnet pass output into insertable proposals.
 * Ungrounded or malformed entries are dropped and counted, never stored.
 */
export function groundSonnetProposals(entries, existingKeys) {
  const keys = new Set(existingKeys);
  const grounded = [];
  let dropped = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const quote = typeof e?.quote === 'string' ? e.quote.trim() : '';
    const statement = typeof e?.statement === 'string' ? e.statement.trim() : '';
    if (!statement || quote.length < 5 || !FACT_CATEGORIES.includes(e.category)) {
      dropped++;
      continue;
    }
    const key = ensureUniqueKey(keys, slugifyKey(e.category, statement));
    keys.add(key);
    grounded.push({
      category: e.category,
      key,
      value: statement,
      detail: e.detail && typeof e.detail === 'object' ? e.detail : null,
      confidence: 'tentative',
      evidence: [{ quote, date: e.date || null, source_field: 'sonnet_backfill' }],
    });
  }
  return { grounded, dropped };
}
