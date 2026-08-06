/**
 * pipelineView — the "is the pipeline clear?" decision.
 *
 * The fixtures here are shaped from a real `GET /dev/requests` capture taken on
 * 2026-08-06: 43 unarchived rows of which 34 were `deployed`, plus PRs #120,
 * #125 and #126 each owning two rows. That feed is what used to render as a
 * wall of cards on an idle pipeline, so it is what these tests assert against.
 */
import {
  buildPipelineView,
  changeKey,
  laneFor,
  relativeTime,
  summaryLine,
} from '../services/pipelineView';
import type { DevRequest, DevRequestStatus } from '../services/devService';

let seq = 0;
function row(over: Partial<DevRequest> & { status: DevRequestStatus }): DevRequest {
  seq += 1;
  return {
    id: over.id ?? `id-${seq}`,
    title: over.title ?? `change ${seq}`,
    target: over.target ?? 'backend',
    source: over.source ?? 'directive',
    created_at: over.created_at ?? `2026-08-0${(seq % 5) + 1}T00:00:00.000Z`,
    ...over,
  } as DevRequest;
}

describe('laneFor', () => {
  it('treats every unfinished status as active', () => {
    for (const s of ['pending', 'building', 'in_review', 'merging', 'deploying', 'failed', 'needs_attention'] as const) {
      expect(laneFor(s)).toBe('active');
    }
  });

  it('treats deployed, superseded and duplicate as history', () => {
    for (const s of ['deployed', 'superseded', 'duplicate'] as const) {
      expect(laneFor(s)).toBe('recent');
    }
  });
});

describe('buildPipelineView — the clear state', () => {
  it('reports clear when every row is terminal', () => {
    const view = buildPipelineView([
      row({ status: 'deployed', pr_number: 137 }),
      row({ status: 'deployed', pr_number: 136 }),
      row({ status: 'superseded', pr_number: 121 }),
      row({ status: 'duplicate' }),
    ]);
    expect(view.isClear).toBe(true);
    expect(view.active).toHaveLength(0);
    expect(summaryLine(view)).toBe('Pipeline clear — nothing in flight');
  });

  it('reports clear for an empty feed', () => {
    const view = buildPipelineView([]);
    expect(view.isClear).toBe(true);
    expect(summaryLine(view)).toBe('Pipeline clear — nothing in flight');
  });

  it('names the last shipped change so "clear" is evidenced, not asserted', () => {
    const view = buildPipelineView([
      row({ status: 'deployed', pr_number: 130, title: 'older', updated_at: '2026-08-05T18:40:00.000Z' }),
      row({ status: 'deployed', pr_number: 137, title: 'newest', updated_at: '2026-08-06T01:13:00.000Z' }),
      row({ status: 'superseded', pr_number: 121, updated_at: '2026-08-06T02:00:00.000Z' }),
    ]);
    expect(view.lastShipped?.request.title).toBe('newest');
  });

  it('is NOT clear while a single row is still in flight', () => {
    const view = buildPipelineView([
      ...Array.from({ length: 30 }, () => row({ status: 'deployed' })),
      row({ status: 'pending', title: 'the one that matters' }),
    ]);
    expect(view.isClear).toBe(false);
    expect(view.active.map((c) => c.request.title)).toEqual(['the one that matters']);
    expect(summaryLine(view)).toBe('1 change in flight');
  });

  it('calls out rows that are stuck rather than moving', () => {
    const view = buildPipelineView([
      row({ status: 'building' }),
      row({ status: 'needs_attention' }),
      row({ status: 'failed' }),
    ]);
    expect(summaryLine(view)).toBe('3 changes in flight · 2 need attention');
  });
});

describe('buildPipelineView — history stays out of the default view', () => {
  it('puts terminal rows in recent, never in active', () => {
    const view = buildPipelineView([
      row({ status: 'deployed', pr_number: 137 }),
      row({ status: 'superseded', pr_number: 110 }),
      row({ status: 'duplicate' }),
      row({ status: 'deploying', pr_number: 140 }),
    ]);
    expect(view.active).toHaveLength(1);
    expect(view.active[0].request.pr_number).toBe(140);
    expect(view.recent).toHaveLength(3);
  });

  it('drops archived rows from both lanes', () => {
    const view = buildPipelineView([
      row({ status: 'pending', archived: true }),
      row({ status: 'deployed', archived: true }),
    ]);
    expect(view.isClear).toBe(true);
    expect(view.recent).toHaveLength(0);
  });

  it('caps history so a long-lived pipeline cannot regrow the wall', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ status: 'deployed', pr_number: 1000 + i }));
    expect(buildPipelineView(rows, { recentLimit: 5 }).recent).toHaveLength(5);
  });
});

describe('buildPipelineView — one change, one card', () => {
  it('collapses the several rows a single PR accumulates', () => {
    const view = buildPipelineView([
      row({ id: 'a', status: 'deployed', pr_number: 126, work_item_id: 'wi-1', updated_at: '2026-08-05T00:43:00.000Z' }),
      row({ id: 'b', status: 'deployed', pr_number: 126, updated_at: '2026-08-05T00:54:00.000Z' }),
    ]);
    expect(view.recent).toHaveLength(1);
    expect(view.recent[0].collapsed).toHaveLength(1);
    // The row the rest of the pipeline references wins.
    expect(view.recent[0].request.id).toBe('a');
  });

  it('collapses a superseded attempt under the survivor that replaced it', () => {
    const view = buildPipelineView([
      row({ id: 'old', status: 'superseded', pr_number: 121, work_item_id: 'wi-9' }),
      row({ id: 'new', status: 'deployed', pr_number: 121, work_item_id: 'wi-9' }),
    ]);
    expect(view.recent).toHaveLength(1);
    expect(view.recent[0].request.id).toBe('new');
    expect(view.recent[0].collapsed.map((r) => r.id)).toEqual(['old']);
  });

  it('lets live work speak for a change even when a dead row shares its key', () => {
    const view = buildPipelineView([
      row({ id: 'dead', status: 'superseded', work_item_id: 'wi-2' }),
      row({ id: 'retry', status: 'building', work_item_id: 'wi-2' }),
    ]);
    expect(view.isClear).toBe(false);
    expect(view.active[0].request.id).toBe('retry');
  });

  it('never merges two changes that only share a similar title', () => {
    const view = buildPipelineView([
      row({ id: 'x', status: 'pending', title: 'Add retry logic to agent fetch calls' }),
      row({ id: 'y', status: 'pending', title: 'Add retry logic to agent fetch calls' }),
    ]);
    expect(view.active).toHaveLength(2);
  });

  it('de-duplicates the same row arriving from two feeds', () => {
    const one = row({ id: 'same', status: 'building', updated_at: '2026-08-06T02:00:00.000Z' });
    const fresher = { ...one, status: 'in_review' as const, updated_at: '2026-08-06T02:05:00.000Z' };
    const view = buildPipelineView([one, fresher]);
    expect(view.active).toHaveLength(1);
    expect(view.active[0].request.status).toBe('in_review');
  });

  it('keys a change by PR, then work item, then branch, then row id', () => {
    expect(changeKey(row({ status: 'deployed', pr_number: 7, work_item_id: 'w' }))).toBe('pr:7');
    expect(changeKey(row({ status: 'deployed', work_item_id: 'w', branch: 'b' }))).toBe('wi:w');
    expect(changeKey(row({ status: 'deployed', branch: 'b' }))).toBe('br:b');
    expect(changeKey(row({ id: 'z', status: 'pending' }))).toBe('id:z');
  });
});

describe('buildPipelineView — PRs raised outside the app', () => {
  // The reconciler adopts any PR it cannot account for (source 'github'), which
  // is how a hand-raised PR gets tracked. The screen has to show it like any
  // other work, or "every change is visible" is not true.
  it('shows an adopted GitHub PR as active work', () => {
    const view = buildPipelineView([
      row({ status: 'deployed', pr_number: 137 }),
      row({
        id: 'adopted',
        status: 'in_review',
        source: 'github',
        pr_number: 141,
        title: 'fix(pipeline): make a clear pipeline read as clear',
      }),
    ]);
    expect(view.isClear).toBe(false);
    expect(view.active).toHaveLength(1);
    expect(view.active[0].request.source).toBe('github');
    expect(view.active[0].request.pr_number).toBe(141);
  });

  it('keeps one card when a PR owns two rows, and lets the unfinished one speak', () => {
    const view = buildPipelineView([
      row({ id: 'adopted', status: 'deployed', source: 'github', pr_number: 141 }),
      row({ id: 'callback', status: 'deploying', source: 'github', pr_number: 141 }),
    ]);
    // The in-flight row still speaks: the deploy is not finished for that PR.
    expect(view.active).toHaveLength(1);
    expect(view.recent).toHaveLength(0);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-08-06T02:00:00.000Z');
  it('reads in minutes, hours then days', () => {
    expect(relativeTime('2026-08-06T01:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-08-06T01:30:00.000Z', now)).toBe('30m ago');
    expect(relativeTime('2026-08-05T22:00:00.000Z', now)).toBe('4h ago');
    expect(relativeTime('2026-08-03T02:00:00.000Z', now)).toBe('3d ago');
  });

  it('says nothing rather than NaN for a missing or broken timestamp', () => {
    expect(relativeTime(undefined, now)).toBe('');
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});
