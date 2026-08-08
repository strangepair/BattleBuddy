// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { calculateStreak } from '../services/streakCalculator.js';
import type { ResistanceBlock } from '../db/schema.js';

function makeBlock(overrides: Partial<ResistanceBlock> = {}): ResistanceBlock {
  return {
    id: 'test-id',
    user_id: 'user-1',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_minutes: 3,
    urge_occurred: false,
    session_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('calculateStreak', () => {
  it('returns zeros for empty input', () => {
    const result = calculateStreak([]);
    assert.equal(result.currentStreakBlocks, 0);
    assert.equal(result.longestStreakBlocks, 0);
    assert.equal(result.currentStreakMinutes, 0);
    assert.equal(result.latestMilestone, null);
  });

  it('counts a single clean block as streak of 1', () => {
    const result = calculateStreak([makeBlock()]);
    assert.equal(result.currentStreakBlocks, 1);
    assert.equal(result.longestStreakBlocks, 1);
    assert.equal(result.currentStreakMinutes, 3);
    assert.equal(result.latestMilestone, '3min_streak');
  });

  it('resets current streak on a usage event (urge_occurred = true)', () => {
    const blocks = [
      makeBlock({ started_at: '2026-01-01T00:00:00Z', urge_occurred: false }),
      makeBlock({ started_at: '2026-01-01T00:03:00Z', urge_occurred: false }),
      makeBlock({ started_at: '2026-01-01T00:06:00Z', urge_occurred: true }),
      makeBlock({ started_at: '2026-01-01T00:09:00Z', urge_occurred: false }),
    ];
    const result = calculateStreak(blocks);
    assert.equal(result.currentStreakBlocks, 1);
    assert.equal(result.longestStreakBlocks, 2);
  });

  it('detects 3hr milestone at 60 consecutive clean blocks', () => {
    const blocks: ResistanceBlock[] = [];
    for (let i = 0; i < 60; i++) {
      blocks.push(makeBlock({
        started_at: new Date(Date.now() + i * 3 * 60 * 1000).toISOString(),
        urge_occurred: false,
      }));
    }
    const result = calculateStreak(blocks);
    assert.equal(result.currentStreakBlocks, 60);
    assert.equal(result.latestMilestone, '3hr_block');
    assert.equal(result.currentStreakMinutes, 180);
  });

  it('returns null milestone for a streak that ends on usage event', () => {
    const blocks = [
      makeBlock({ started_at: '2026-01-01T00:00:00Z', urge_occurred: true }),
    ];
    const result = calculateStreak(blocks);
    assert.equal(result.currentStreakBlocks, 0);
    assert.equal(result.latestMilestone, null);
  });
});
