// pipelineView.ts — turn the raw dev_build_requests feed into what the Build
// pipeline screen actually shows.
//
// WHY THIS EXISTS
//
// `GET /dev/requests` is a log, not a view. On a healthy, idle pipeline it
// returns ~100 rows of which 95% are terminal (deployed / superseded /
// duplicate) — and the screen used to render every non-archived one of them as
// a card. So "the pipeline is clear" and "the pipeline is buried" looked
// IDENTICAL: a wall of cards either way. The one state the operator most needs
// to read at a glance was the one the screen could not express.
//
// Two more things the flat list got wrong, both visible in production data:
//   - a status the client did not know (`superseded`, added by migration 022)
//     fell through to the `pending` label, so 31 dead rows read
//     "Pending development";
//   - one change routinely owns several rows (a callback row plus a reconciled
//     row plus the row a retry superseded), so PRs #120, #125 and #126 each
//     appeared two or three times.
//
// This module is pure and has no React or fetch in it, which is the point: the
// "is it clear?" decision is the thing most worth testing, and it can be tested
// against a real captured feed with no renderer in the way.

import type { DevRequest, DevRequestStatus } from './devService';

/** Still in the pipeline's hands — these are what "in flight" means. */
export const ACTIVE_STATUSES: DevRequestStatus[] = [
  'pending', 'building', 'in_review', 'merging', 'deploying', 'failed', 'needs_attention',
];

/** Done, one way or another. History, not work. */
export const TERMINAL_STATUSES: DevRequestStatus[] = ['deployed', 'superseded', 'duplicate'];

export type PipelineLane = 'active' | 'recent';

export function laneFor(status: DevRequestStatus): PipelineLane {
  return (TERMINAL_STATUSES as string[]).includes(status) ? 'recent' : 'active';
}

/** One change: the row that speaks for it, plus the rows it absorbed. */
export interface PipelineCard {
  /** Stable across polls — the survivor's id, so React keys don't churn. */
  key: string;
  request: DevRequest;
  lane: PipelineLane;
  /** Rows collapsed under this one (duplicate callbacks, superseded retries). */
  collapsed: DevRequest[];
}

export interface PipelineView {
  /** Everything the pipeline is currently working on or stuck on. */
  active: PipelineCard[];
  /** Terminal history, newest first. Belongs behind a disclosure, not on top. */
  recent: PipelineCard[];
  /** True when nothing is in flight — the state the screen must say out loud. */
  isClear: boolean;
  /** Newest successfully deployed change, for the "last shipped" line. */
  lastShipped: PipelineCard | null;
}

// How advanced a terminal outcome is, when several rows describe one change.
// `deployed` is the truth; `superseded` is the least informative thing a row can
// say, so it never speaks for a change that has anything better to say.
const TERMINAL_RANK: Record<string, number> = { deployed: 3, duplicate: 2, superseded: 1 };

// How far along an in-flight row is. Used only to pick a survivor, never to
// order the lane — the operator reads the lane by recency, not by stage.
const ACTIVE_RANK: Record<string, number> = {
  deploying: 6, merging: 5, in_review: 4, building: 3, needs_attention: 2, failed: 2, pending: 1,
};

function time(r: DevRequest): number {
  const t = Date.parse(r.updated_at || r.created_at || '');
  return Number.isNaN(t) ? 0 : t;
}

/**
 * What identifies the CHANGE behind a row.
 *
 * A PR number is the strongest signal and the one that actually collapses the
 * production duplicates. Titles are deliberately NOT used: the spec generator
 * emits near-identical titles for genuinely different requests, and collapsing
 * those would hide work rather than tidy it.
 */
export function changeKey(r: DevRequest): string {
  if (r.pr_number) return `pr:${r.pr_number}`;
  if (r.work_item_id) return `wi:${r.work_item_id}`;
  if (r.branch) return `br:${r.branch}`;
  return `id:${r.id}`;
}

/**
 * Which row speaks for a change.
 *
 * An in-flight row always wins: a retry of a superseded change is live work and
 * saying otherwise would hide it from the only lane that is read. Among rows in
 * the same lane, the more advanced status wins, then the more recent one.
 */
function pickSurvivor(rows: DevRequest[]): DevRequest {
  return [...rows].sort((a, b) => {
    const aActive = laneFor(a.status) === 'active';
    const bActive = laneFor(b.status) === 'active';
    if (aActive !== bActive) return aActive ? -1 : 1;
    const rank = aActive ? ACTIVE_RANK : TERMINAL_RANK;
    const byRank = (rank[b.status] ?? 0) - (rank[a.status] ?? 0);
    if (byRank !== 0) return byRank;
    // A row carrying a work item is the one the rest of the pipeline references.
    const byLink = Number(Boolean(b.work_item_id)) - Number(Boolean(a.work_item_id));
    if (byLink !== 0) return byLink;
    return time(b) - time(a);
  })[0];
}

export interface BuildViewOptions {
  /** Cap on the history lane so a long-lived pipeline cannot regrow the wall. */
  recentLimit?: number;
}

/**
 * Build the screen's view model from however many feeds it fetched.
 *
 * Accepts overlapping arrays on purpose — the screen asks for the newest window
 * AND, separately, for every active row regardless of age, so an old row still
 * in flight cannot fall off the back of the window. Rows are de-duplicated by
 * id before anything else happens.
 */
export function buildPipelineView(
  requests: DevRequest[],
  { recentLimit = 25 }: BuildViewOptions = {},
): PipelineView {
  const byId = new Map<string, DevRequest>();
  for (const r of requests || []) {
    if (!r?.id || r.archived) continue;   // archived rows live behind their own toggle
    const seen = byId.get(r.id);
    if (!seen || time(r) >= time(seen)) byId.set(r.id, r);
  }

  const groups = new Map<string, DevRequest[]>();
  for (const r of byId.values()) {
    const key = changeKey(r);
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }

  const cards: PipelineCard[] = [];
  for (const rows of groups.values()) {
    const survivor = pickSurvivor(rows);
    cards.push({
      key: survivor.id,
      request: survivor,
      lane: laneFor(survivor.status),
      collapsed: rows.filter((r) => r.id !== survivor.id),
    });
  }

  const byRecency = (a: PipelineCard, b: PipelineCard) => time(b.request) - time(a.request);
  const active = cards.filter((c) => c.lane === 'active').sort(byRecency);
  const recent = cards.filter((c) => c.lane === 'recent').sort(byRecency);

  return {
    active,
    recent: recent.slice(0, recentLimit),
    isClear: active.length === 0,
    lastShipped: recent.find((c) => c.request.status === 'deployed') ?? null,
  };
}

/** The one line at the top of the screen. */
export function summaryLine(view: PipelineView): string {
  if (view.isClear) return 'Pipeline clear — nothing in flight';
  const n = view.active.length;
  const stuck = view.active.filter(
    (c) => c.request.status === 'needs_attention' || c.request.status === 'failed',
  ).length;
  const head = `${n} change${n === 1 ? '' : 's'} in flight`;
  return stuck > 0 ? `${head} · ${stuck} need${stuck === 1 ? 's' : ''} attention` : head;
}

/** "2h ago" / "3d ago" — relative, because the exact minute never matters here. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
