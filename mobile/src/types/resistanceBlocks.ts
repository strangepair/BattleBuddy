export interface ResistanceBlock {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  urge_occurred: boolean;
  session_date: string;
}

export interface StreakResult {
  currentStreakBlocks: number;
  longestStreakBlocks: number;
  currentStreakMinutes: number;
  latestMilestone: string | null;
}
