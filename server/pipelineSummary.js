// pipelineSummary.js — one derivation of "what is the pipeline doing right now".
//
// WHY THIS EXISTS
//
// The Dev tab's summary line was computed from `work_items`, and wrongly:
//
//   parts.push(`${workItems.length} work items in flight`)   // workItems = .limit(20)
//
// `workItems` was the newest TWENTY rows of that table regardless of stage, so
// the headline number was pinned at 20 forever once the table had 20 rows, and
// it counted `live` (already shipped) and `archived` items as "in flight". It
// read "20 work items in flight — (4 building, 2 verifying, 3 understood, 11
// live)" against a pipeline whose true in-flight count was zero. A summary that
// cannot go down is not a summary.
//
// The deeper fault was the SOURCE. `work_items.stage` is a projection that is
// only advanced when something remembers to advance it. `dev_build_requests` is
// what the GitHub-truth reconciler repairs every 60 seconds, and it is what the
// cards on the screen are drawn from. A summary derived from anything else can
// disagree with the cards underneath it, which is the one thing it must never
// do. So: same table, same archived filter, same per-change de-duplication as
// the client's pipelineView.ts, and the numbers cannot drift apart.

/** Still the pipeline's problem — GitHub or the queue has not finished with it. */
export const MOVING_STATUSES = ['pending', 'building', 'in_review', 'merging', 'deploying'];
/** In flight, but not moving on its own — a human or a retry has to act. */
export const ATTENTION_STATUSES = ['failed', 'needs_attention'];
/** Done, one way or another. */
export const TERMINAL_STATUSES = ['deployed', 'superseded', 'duplicate'];

export const IN_FLIGHT_STATUSES = [...MOVING_STATUSES, ...ATTENTION_STATUSES];

/**
 * What identifies the CHANGE behind a row — the same precedence the client
 * uses, so a change that owns three rows counts once in both places.
 */
export function changeKey(r) {
  if (r.pr_number) return `pr:${r.pr_number}`;
  if (r.work_item_id) return `wi:${r.work_item_id}`;
  if (r.branch) return `br:${r.branch}`;
  return `id:${r.id}`;
}

function time(r) {
  const t = Date.parse(r?.updated_at || r?.created_at || '');
  return Number.isNaN(t) ? 0 : t;
}

const MOVING_RANK = { deploying: 6, merging: 5, in_review: 4, building: 3, pending: 1 };
const ATTENTION_RANK = { needs_attention: 2, failed: 2 };
const TERMINAL_RANK = { deployed: 3, duplicate: 2, superseded: 1 };

function laneOf(status) {
  if (MOVING_STATUSES.includes(status)) return 'moving';
  if (ATTENTION_STATUSES.includes(status)) return 'attention';
  return 'terminal';
}

const LANE_ORDER = { moving: 0, attention: 1, terminal: 2 };

/** Which row speaks for a change: live work first, then the furthest along. */
function pickSurvivor(rows) {
  return [...rows].sort((a, b) => {
    const byLane = LANE_ORDER[laneOf(a.status)] - LANE_ORDER[laneOf(b.status)];
    if (byLane !== 0) return byLane;
    const rank = { ...MOVING_RANK, ...ATTENTION_RANK, ...TERMINAL_RANK };
    const byRank = (rank[b.status] ?? 0) - (rank[a.status] ?? 0);
    if (byRank !== 0) return byRank;
    return time(b) - time(a);
  })[0];
}

/**
 * Counts, per CHANGE rather than per row, from the reconciled request table.
 *
 * @param {Array} rows dev_build_requests rows (archived ones are ignored here
 *                     rather than filtered by the caller, so a caller that
 *                     forgets the filter cannot inflate the numbers).
 */
export function summarize(rows, now = Date.now()) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!r?.id || r.archived) continue;
    const key = changeKey(r);
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }

  const byStatus = {};
  const moving = [];
  const attention = [];
  const terminal = [];
  for (const g of groups.values()) {
    const row = pickSurvivor(g);
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    const lane = laneOf(row.status);
    if (lane === 'moving') moving.push(row);
    else if (lane === 'attention') attention.push(row);
    else terminal.push(row);
  }

  const byRecency = (a, b) => time(b) - time(a);
  moving.sort(byRecency);
  attention.sort(byRecency);
  terminal.sort(byRecency);

  const shipped = terminal.filter((r) => r.status === 'deployed')[0] || null;

  return {
    inFlight: moving.length + attention.length,
    moving: moving.length,
    attention: attention.length,
    terminal: terminal.length,
    changes: groups.size,
    byStatus,
    // Enough to render the in-flight list without a second call, capped so a
    // pathological queue cannot make this response unbounded.
    inFlightItems: [...moving, ...attention].slice(0, 25).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      source: r.source,
      pr_number: r.pr_number ?? null,
      error: r.error ?? null,
      updated_at: r.updated_at ?? r.created_at,
    })),
    lastShipped: shipped
      ? {
          id: shipped.id,
          title: shipped.title,
          pr_number: shipped.pr_number ?? null,
          at: shipped.updated_at ?? shipped.created_at,
        }
      : null,
    generatedAt: new Date(now).toISOString(),
  };
}

function ago(iso, now) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The one-line version, for the summary strip at the top of the Dev tab.
 *
 * Deliberately says the SAME thing the client's own banner says when the
 * pipeline is idle: two components disagreeing about whether the pipeline is
 * clear is worse than either of them being briefly stale.
 */
export function digestLine(summary, now = Date.now()) {
  const parts = [];
  if (summary.inFlight === 0) {
    parts.push('Pipeline clear — nothing in flight');
  } else {
    parts.push(`${summary.inFlight} change${summary.inFlight === 1 ? '' : 's'} in flight`);
    const detail = [];
    if (summary.moving > 0) {
      const stages = MOVING_STATUSES
        .filter((s) => summary.byStatus[s])
        .map((s) => `${summary.byStatus[s]} ${s.replace('_', ' ')}`);
      detail.push(...stages);
    }
    if (summary.attention > 0) {
      detail.push(`${summary.attention} needing attention`);
    }
    if (detail.length) parts.push(`(${detail.join(', ')})`);
  }
  if (summary.lastShipped) {
    const pr = summary.lastShipped.pr_number ? ` PR #${summary.lastShipped.pr_number}` : '';
    parts.push(`last shipped${pr} ${ago(summary.lastShipped.at, now)}`.trim());
  }
  return parts.join(' — ').slice(0, 600);
}
