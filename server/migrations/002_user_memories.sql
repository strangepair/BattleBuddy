-- Full-text search memory store (replaces pgvector embeddings)
-- Run via Supabase SQL Editor or psql

CREATE TABLE IF NOT EXISTS user_memories (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  content text NOT NULL,
  type text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_memories_search_idx ON user_memories USING gin(search_vector);
CREATE INDEX IF NOT EXISTS user_memories_user_idx ON user_memories(user_id);

-- Helper function for full-text ranked retrieval
CREATE OR REPLACE FUNCTION match_user_memories(
  match_user_id text,
  query_text text,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  content text,
  type text,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    um.id,
    um.content,
    um.type,
    ts_rank(um.search_vector, plainto_tsquery('english', query_text))::float AS similarity,
    um.created_at
  FROM user_memories um
  WHERE um.user_id = match_user_id
    AND um.search_vector @@ plainto_tsquery('english', query_text)
  ORDER BY similarity DESC, um.created_at DESC
  LIMIT match_count;
END;
$$;
