CREATE TYPE IF NOT EXISTS rot_milestone_type AS ENUM ('3min_streak','3hr_block','3day_block','3week_block','3month_block','3year_block');
CREATE TABLE IF NOT EXISTS rule_of_three_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  milestone_type rot_milestone_type NOT NULL,
  achieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocks_count INTEGER NOT NULL DEFAULT 0,
  personal_best BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rot_milestones_user ON rule_of_three_milestones(user_id, milestone_type);
