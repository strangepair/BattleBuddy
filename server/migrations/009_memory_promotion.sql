-- Two-tier memory: a small "promoted" set that is injected on every turn,
-- alongside the existing similarity-retrieved set.
--
-- Why: retrieval in match_user_memories is keyed off what the user just said.
-- At the top of a session nobody has said anything yet, so the query is empty
-- and nothing is retrieved — which is why greetings read as though BB has never
-- met this person. A memory that is always in context doesn't need a query to
-- surface it.
--
-- Deliberately additive: `promoted` defaults to false, so until the promotion
-- job (migration 010 + promotionJob.js) starts marking rows, this changes
-- nothing at runtime — getPromotedMemories just returns an empty list and the
-- prompt renders the same "nothing yet" fallback it would have anyway.
--
-- Run via Supabase SQL Editor or psql.

alter table user_memories add column if not exists promoted boolean not null default false;
alter table user_memories add column if not exists promoted_at timestamptz;

-- Partial index, unlike the deliberate no-index call in 008. Two things differ
-- here: this predicate is exact equality rather than nearest-neighbour (so an
-- index actually helps and can't lose recall the way ivfflat did), and this
-- query runs on *every* turn including the greeting, where 008's vector scan
-- only runs mid-conversation. The index covers promoted rows only, so it stays
-- small — a few rows per user, not the whole 3.4K-row table.
create index if not exists user_memories_promoted_idx
  on user_memories (user_id, promoted_at desc)
  where promoted;

comment on column user_memories.promoted is
  'Injected into every turn rather than retrieved by similarity. Set by the nightly promotion job; see server/promotionJob.js for the scoring and thresholds.';
