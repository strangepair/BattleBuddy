-- Recall-as-signal: retrieval frequency becomes the evidence for promotion.
--
-- The idea (borrowed from openclaw's memory-core, reimplemented here on
-- Postgres): every time a memory is actually retrieved and used in a turn, that
-- is evidence it matters. Memory that keeps proving useful graduates itself into
-- the always-injected tier from 009. Nothing has to guess up front which
-- memories are important — usage decides.
--
-- Run via Supabase SQL Editor or psql. Requires 009.

alter table user_memories add column if not exists recall_count int not null default 0;
alter table user_memories add column if not exists total_score real not null default 0;
alter table user_memories add column if not exists concept_tags text[] not null default '{}';
alter table user_memories add column if not exists last_recalled_at timestamptz;

-- One array instead of three. Each entry is 'YYYY-MM-DD:<query-hash>', which
-- carries everything the scorer needs: distinct days (prefix) measure whether
-- recall is spread over time, distinct hashes (suffix) measure whether it
-- surfaced across genuinely different contexts, and the pair is the dedupe key.
--
-- The dedupe matters. Without it one chatty session — same worry, same phrasing,
-- fifteen turns — looks identical to fifteen days of recurrence, and everything
-- retrieved during a long session promotes itself at once.
alter table user_memories add column if not exists recall_keys text[] not null default '{}';

comment on column user_memories.recall_keys is
  'YYYY-MM-DD:<query-hash> per counted recall, oldest first, capped at 128. Days measure spacing, hashes measure context diversity, the pair deduplicates.';

-- Partial index: the sweep only ever looks at memories with recall evidence,
-- which is a small slice of the table.
create index if not exists user_memories_recall_idx
  on user_memories (user_id, recall_count desc)
  where recall_count > 0;

-- Record a batch of recalls in one round trip.
--
-- Called fire-and-forget from the hot path after retrieveRelevant, so it must
-- stay a single statement — one call per turn, not one per memory. The
-- `not (recall_key = any(...))` guard is the per-(day, query) dedupe; a repeat
-- of the same query on the same day updates nothing and returns 0.
create or replace function record_memory_recalls(
  memory_ids uuid[],
  similarities real[],
  recall_key text
)
returns integer
language plpgsql
as $$
declare
  updated integer;
begin
  with scored as (
    select id, ord, similarities[ord] as sim
    from unnest(memory_ids) with ordinality as t(id, ord)
  )
  update user_memories um
  set recall_count     = um.recall_count + 1,
      total_score      = um.total_score + coalesce(scored.sim, 0),
      -- Append, then keep the newest 128. cardinality() (not array_length())
      -- because it returns 0 rather than NULL for an empty array, which is the
      -- state every row starts in.
      recall_keys      = (um.recall_keys || recall_key)[
                           greatest(1, cardinality(um.recall_keys) + 2 - 128) :
                         ],
      last_recalled_at = now()
  from scored
  where um.id = scored.id
    and not (recall_key = any(um.recall_keys));

  get diagnostics updated = row_count;
  return updated;
end;
$$;
