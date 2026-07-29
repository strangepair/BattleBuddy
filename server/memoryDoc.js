/**
 * Memory Document — renders a user's active canonical facts into the per-user
 * markdown document (spec §3.3, the Obsidian pattern, cloud-shaped).
 *
 * One renderer, two consumers: the same output fills {{profile}} in the system
 * prompt and backs the user-facing "My Memory" screen/export. That identity is
 * the trust win — the doc the user corrects is byte-for-byte the doc the agent
 * reads. Everything here is pure (facts in, string out; time injected) so it
 * tests without a database and stays deterministic.
 *
 * Budget discipline: trimmed by importance, never recency — tentative facts
 * drop first, then stale-flagged, then lowest-evidence. The founding
 * motivation captured in week one must never be the thing that gets cut.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DOC_BUDGET = 12000; // chars — same cap buildProfileSummary holds

/** A fact is stale when its review horizon has passed. Durable facts
 * (review_after null) never go stale. */
export function isStale(fact, nowMs) {
  return !!fact.review_after && Date.parse(fact.review_after) <= nowMs;
}

function evidenceCount(fact) {
  return Array.isArray(fact.evidence) ? fact.evidence.length : 0;
}

/**
 * Importance-ordered trim: returns the facts to keep under `budget` rendered
 * chars, dropping in order (1) tentative, (2) stale, (3) lowest evidence.
 * Within each tier the least-evidenced goes first. Exported for tests.
 */
export function selectFactsForBudget(facts, budget, nowMs, renderFn) {
  let kept = [...facts];
  const overBudget = () => renderFn(kept).length > budget;
  if (!overBudget()) return kept;

  const tiers = [
    f => f.confidence === 'tentative',
    f => isStale(f, nowMs),
    () => true,
  ];

  for (const inTier of tiers) {
    // Drop one at a time, least-evidenced first, until under budget or the
    // tier is exhausted.
    while (overBudget()) {
      const candidates = kept.filter(inTier);
      if (!candidates.length) break;
      candidates.sort((a, b) => evidenceCount(a) - evidenceCount(b));
      const drop = candidates[0];
      kept = kept.filter(f => f !== drop);
    }
    if (!overBudget()) break;
  }
  return kept;
}

const CONFIDENCE_PREFIX = {
  tentative: 'mentioned once: ',
  observed: '',
  confirmed: '',
};

function factLine(fact, { staleNudgeKey, nowMs }) {
  const hedge = CONFIDENCE_PREFIX[fact.confidence] || '';
  let line = `- ${hedge}${fact.value}`;

  const d = fact.detail || {};
  const annotations = [];
  if (fact.category === 'trigger' && d.intensity) annotations.push(`intensity ${d.intensity}/10`);
  if (fact.category === 'coping' && d.effectiveness) {
    annotations.push(
      d.effectiveness === 'working' ? `working${d.resist_count ? ` — ${d.resist_count} resists` : ''}`
        : d.effectiveness === 'failed' ? 'has NOT worked for them — do not re-suggest'
          : 'untested'
    );
  }
  if (fact.category === 'window' && typeof d.hour === 'number') {
    const h = d.hour % 24;
    const clock = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
    const dow = typeof d.day_of_week === 'number'
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.day_of_week] + ' '
      : '';
    annotations.push(`${dow}${clock}`);
  }
  if (annotations.length) line += ` (${annotations.join('; ')})`;

  if (isStale(fact, nowMs)) {
    line += fact.key === staleNudgeKey
      ? ' ⚠ may be stale — reconfirm naturally in conversation'
      : ' ⚠ may be stale';
  }
  if (fact.conflict_with) {
    line += ' ⚠ conflicting notes on this — clarify naturally when it fits';
  }
  return line;
}

const SECTIONS = [
  { title: name => `What you know about ${name}`, categories: ['identity', 'quit'] },
  { title: () => "Why they're quitting — their words", categories: ['motivation'] },
  { title: () => 'Triggers and risk windows', categories: ['trigger', 'window'] },
  { title: () => 'Daily structure', categories: ['routine'] },
  { title: () => "What works and what doesn't", categories: ['coping'] },
  { title: () => 'Their people', categories: ['person'] },
  { title: () => 'Watch for', categories: ['watch'] },
  { title: () => 'How they want you to be', categories: ['preference'] },
];

const CONFIDENCE_ORDER = { confirmed: 0, observed: 1, tentative: 2 };

/**
 * Render the memory document.
 *
 * @param {Array} facts - active fact rows (factStore shape)
 * @param {object} [opts]
 * @param {string} [opts.name] - user's display name for the heading
 * @param {Array}  [opts.commitments] - open user_commitments rows, rendered alongside
 * @param {number} [opts.budget] - char budget (DEFAULT_DOC_BUDGET)
 * @param {number} [opts.nowMs] - injected clock for stale checks (testability)
 * @returns {string} markdown document; empty-state sentence when no facts
 */
export function renderMemoryDoc(facts, opts = {}) {
  const {
    name = 'this person',
    commitments = [],
    budget = DEFAULT_DOC_BUDGET,
    nowMs = Date.now(),
  } = opts;

  if (!facts || facts.length === 0) {
    return 'New user — no confirmed facts yet. Learn through conversation, never invent.';
  }

  // Exactly one reconfirm call-to-action per render (interrogation guard,
  // spec §3.5): the most overdue stale fact gets it; other stale facts are
  // marked but not nudged.
  const pickStaleNudgeKey = list => {
    const stale = list.filter(f => isStale(f, nowMs));
    if (!stale.length) return null;
    stale.sort((a, b) => Date.parse(a.review_after) - Date.parse(b.review_after));
    return stale[0].key;
  };

  const renderSet = kept => {
    const staleNudgeKey = pickStaleNudgeKey(kept);
    const parts = [];
    for (const section of SECTIONS) {
      const sectionFacts = kept
        .filter(f => section.categories.includes(f.category))
        .sort((a, b) =>
          (CONFIDENCE_ORDER[a.confidence] ?? 3) - (CONFIDENCE_ORDER[b.confidence] ?? 3)
          || a.key.localeCompare(b.key)
        );
      if (!sectionFacts.length) continue;
      parts.push(`## ${section.title(name)}`);
      for (const f of sectionFacts) parts.push(factLine(f, { staleNudgeKey, nowMs }));
      parts.push('');
    }
    const openCommitments = (commitments || []).filter(c => c.status === 'pending');
    if (openCommitments.length) {
      parts.push('## Open follow-ups');
      for (const c of openCommitments) parts.push(`- ${c.summary}`);
      parts.push('');
    }
    return parts.join('\n').trimEnd();
  };

  const kept = selectFactsForBudget(facts, budget, nowMs, renderSet);
  return renderSet(kept);
}
