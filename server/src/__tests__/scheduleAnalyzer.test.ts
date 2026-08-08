// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { analyzeUserSchedule } from '../services/scheduleAnalyzer.js';
import type { ResistanceBlock } from '../db/schema.js';

function makeBlock(overrides: Partial<ResistanceBlock> = {}): ResistanceBlock {
  return {
    id: 'test-id',
    user_id: 'user-1',
    started_at: '2026-08-01T08:00:00Z',
    ended_at: '2026-08-01T08:03:00Z',
    duration_minutes: 3,
    urge_occurred: false,
    session_date: '2026-08-01',
    created_at: '2026-08-01T08:00:00Z',
    ...overrides,
  };
}

function makeSupabase(blocks: ResistanceBlock[]) {
  return {
    from(_table: string) {
      return {
        select(_cols?: string) { return this; },
        eq(_col: string, _val: unknown) { return this; },
        gte(_col: string, _val: unknown) { return this; },
        then(resolve: (result: { data: ResistanceBlock[]; error: null }) => void) {
          resolve({ data: blocks, error: null });
        },
      };
    },
  };
}

describe('analyzeUserSchedule', () => {
  it('returns insufficientData=true when fewer than 3 distinct session_dates', async () => {
    const blocks = [
      makeBlock({ session_date: '2026-08-01', started_at: '2026-08-01T08:00:00Z' }),
      makeBlock({ session_date: '2026-08-02', started_at: '2026-08-02T08:00:00Z' }),
    ];
    const supabase = makeSupabase(blocks);
    const result = await analyzeUserSchedule('user-1', supabase as never);
    assert.equal(result.insufficientData, true);
    assert.deepEqual(result.windows, []);
  });

  it('returns insufficientData=true for empty data', async () => {
    const supabase = makeSupabase([]);
    const result = await analyzeUserSchedule('user-1', supabase as never);
    assert.equal(result.insufficientData, true);
    assert.deepEqual(result.windows, []);
  });

  it('buckets blocks into correct 3-hour windows', async () => {
    const blocks: ResistanceBlock[] = [
      makeBlock({ session_date: '2026-08-01', started_at: '2026-08-01T07:00:00Z' }),
      makeBlock({ session_date: '2026-08-01', started_at: '2026-08-01T07:30:00Z' }),
      makeBlock({ session_date: '2026-08-02', started_at: '2026-08-02T07:00:00Z' }),
      makeBlock({ session_date: '2026-08-03', started_at: '2026-08-03T10:00:00Z' }),
      makeBlock({ session_date: '2026-08-04', started_at: '2026-08-04T10:00:00Z' }),
      makeBlock({ session_date: '2026-08-05', started_at: '2026-08-05T10:00:00Z' }),
    ];
    const supabase = makeSupabase(blocks);
    const result = await analyzeUserSchedule('user-1', supabase as never);
    assert.equal(result.insufficientData, false);

    const topWindow = result.windows[0];
    assert.ok(
      topWindow.start === '06:00' || topWindow.start === '09:00',
      `Expected top window to be 06:00 or 09:00 but got ${topWindow.start}`,
    );
  });

  it('sorts windows by blockCount descending and returns at most 6', async () => {
    const blocks: ResistanceBlock[] = [];
    const dates = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'];
    for (const date of dates) {
      blocks.push(makeBlock({ session_date: date, started_at: `${date}T08:00:00Z` }));
      blocks.push(makeBlock({ session_date: date, started_at: `${date}T08:30:00Z` }));
    }
    blocks.push(makeBlock({ session_date: '2026-08-01', started_at: '2026-08-01T14:00:00Z' }));

    const supabase = makeSupabase(blocks);
    const result = await analyzeUserSchedule('user-1', supabase as never);
    assert.equal(result.insufficientData, false);
    assert.ok(result.windows.length <= 6);

    for (let i = 1; i < result.windows.length; i++) {
      assert.ok(
        result.windows[i - 1].blockCount >= result.windows[i].blockCount,
        'Windows should be sorted by blockCount descending',
      );
    }

    assert.equal(result.windows[0].start, '06:00');
  });

  it('computes avgCleanBlocksPercent correctly', async () => {
    const blocks: ResistanceBlock[] = [
      makeBlock({ session_date: '2026-08-01', started_at: '2026-08-01T08:00:00Z', urge_occurred: false }),
      makeBlock({ session_date: '2026-08-02', started_at: '2026-08-02T08:00:00Z', urge_occurred: true }),
      makeBlock({ session_date: '2026-08-03', started_at: '2026-08-03T08:00:00Z', urge_occurred: false }),
      makeBlock({ session_date: '2026-08-04', started_at: '2026-08-04T08:00:00Z', urge_occurred: false }),
    ];
    const supabase = makeSupabase(blocks);
    const result = await analyzeUserSchedule('user-1', supabase as never);
    assert.equal(result.insufficientData, false);

    const w = result.windows.find((win) => win.start === '06:00');
    assert.ok(w, 'Expected 06:00 window');
    assert.ok(Math.abs(w.avgCleanBlocksPercent - 0.75) < 0.001, `Expected 0.75 but got ${w.avgCleanBlocksPercent}`);
  });
});
