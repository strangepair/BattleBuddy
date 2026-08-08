CREATE TABLE IF NOT EXISTS resistance_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (ended_at - started_at))/60) STORED,
  urge_occurred BOOLEAN NOT NULL DEFAULT FALSE,
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resistance_blocks_user_date ON resistance_blocks(user_id, session_date);
