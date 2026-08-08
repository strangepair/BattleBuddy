import type { ResistanceBlock, RotMilestoneType } from '../db/schema.js';

export interface StreakResult {
  currentStreakBlocks: number;
  longestStreakBlocks: number;
  currentStreakMinutes: number;
  latestMilestone: RotMilestoneType | null;
}

const MILESTONE_THRESHOLDS: Array<{ blocks: number; type: RotMilestoneType }> = [
  { blocks: 1, type: '3min_streak' },
  { blocks: 60, type: '3hr_block' },
  { blocks: 1440, type: '3day_block' },
  { blocks: 10080, type: '3week_block' },
  { blocks: 43200, type: '3month_block' },
  { blocks: 525960, type: '3year_block' },
];

function milestoneForBlocks(count: number): RotMilestoneType | null {
  let result: RotMilestoneType | null = null;
  for (const { blocks, type } of MILESTONE_THRESHOLDS) {
    if (count >= blocks) result = type;
    else break;
  }
  return result;
}

export function calculateStreak(blocks: ResistanceBlock[]): StreakResult {
  if (blocks.length === 0) {
    return { currentStreakBlocks: 0, longestStreakBlocks: 0, currentStreakMinutes: 0, latestMilestone: null };
  }

  const sorted = [...blocks].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );

  let currentStreak = 0;
  let longestStreak = 0;
  let runStreak = 0;

  for (const block of sorted) {
    if (block.urge_occurred) {
      if (runStreak > longestStreak) longestStreak = runStreak;
      runStreak = 0;
    } else {
      runStreak += 1;
      if (runStreak > longestStreak) longestStreak = runStreak;
    }
  }

  currentStreak = runStreak;
  if (currentStreak > longestStreak) longestStreak = currentStreak;

  const currentStreakMinutes = currentStreak * 3;
  const latestMilestone = milestoneForBlocks(currentStreak);

  return { currentStreakBlocks: currentStreak, longestStreakBlocks: longestStreak, currentStreakMinutes, latestMilestone };
}
