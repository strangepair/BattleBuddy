export type RotMilestoneType =
  | '3min_streak'
  | '3hr_block'
  | '3day_block'
  | '3week_block'
  | '3month_block'
  | '3year_block';

export interface ResistanceBlock {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  urge_occurred: boolean;
  session_date: string;
  created_at: string;
}

export interface RuleOfThreeMilestone {
  id: string;
  user_id: string;
  milestone_type: RotMilestoneType;
  achieved_at: string;
  blocks_count: number;
  personal_best: boolean;
  created_at: string;
}
