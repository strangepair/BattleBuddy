-- Canonical fact layer — one row per fact about a person, updated in place
-- via supersede chains, rendered into every prompt, editable by the user.
-- Design: docs/11-MEMORY-ARCHITECTURE.md; execution: docs/12-MEMORY-IMPL-PLAN.md.
--
-- Deliberately additive and idempotent end to end: deploy.yml re-runs every
-- migration file whenever any migration changes, so each statement here must
-- be safe to run against a database that already has it.
--
-- Run via Supabase SQL Editor or psql. Requires 008 (user_memories + the
-- vector-based match_user_memories this file re-creates with one extra guard).

-- ─── Part 1: user_facts — the canonical store ───────────────────────────────

create table if not exists user_facts (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  -- Taxonomy maps ~1:1 from today's profile fields (spec §3.2). 'commitment'
  -- is deliberately absent: user_commitments already has the right lifecycle
  -- and is rendered alongside, not duplicated here.
  category      text not null check (category in
                  ('identity','quit','trigger','window','routine','coping',
                   'motivation','person','preference','watch')),
  -- Stable slug, e.g. 'trigger.morning-coffee'. Assigned by the merge gate
  -- against the live key list, never freehand — the key is what makes
  -- "update in place" possible.
  key           text not null,
  -- One plain-language sentence, the user's words where possible.
  value         text not null,
  -- Structured payload where useful: hour/dow/weight for windows,
  -- effectiveness + resist counts for coping, relationship for people.
  detail        jsonb,
  -- 'proposed' rows are gate/backfill output awaiting activation; 'rejected'
  -- keeps gate verdicts auditable without a separate log table. Only 'active'
  -- rows are ever rendered into a prompt.
  status        text not null default 'proposed'
                  check (status in ('active','superseded','retired','proposed','rejected')),
  confidence    text not null default 'tentative'
                  check (confidence in ('confirmed','observed','tentative')),
  source        text not null
                  check (source in ('user_edited','user_stated','agent_tool',
                                    'extraction','consolidation','backfill')),
  -- [{session_id, date, quote?}] — where this came from. The anti-fabrication
  -- invariant: every remembered fact points at something the user said or did.
  evidence      jsonb not null default '[]'::jsonb,
  -- Set on both rows of a CONFLICTS pair; the render flags them and the agent
  -- resolves in conversation via correct_memory.
  conflict_with uuid,
  superseded_by uuid references user_facts(id),
  -- Staleness horizon; null = durable. Expiry never removes — it demotes to
  -- "reconfirm naturally in conversation".
  review_after  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One active truth per key. Supersede chains, never competing actives.
create unique index if not exists user_facts_active_key
  on user_facts (user_id, key) where status = 'active';

-- The per-turn read: all of a user's active facts (renderMemoryDoc).
create index if not exists user_facts_user_active
  on user_facts (user_id) where status = 'active';

-- Admin/consolidation scans by status (proposed review, rejected audit).
create index if not exists user_facts_user_status
  on user_facts (user_id, status);

-- RLS on every table (CLAUDE.md rule 4). bb-server writes via the service
-- role and bypasses this; the policy governs future direct client access.
alter table user_facts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'user_facts' and policyname = 'own_facts'
  ) then
    create policy own_facts on user_facts
      using (auth.uid()::text = user_id)
      with check (auth.uid()::text = user_id);
  end if;
end $$;

comment on table user_facts is
  'Canonical per-user facts: one active row per key, superseded in place, injected into every prompt, user-visible/editable. Write discipline in server/factGate.js; rendering in server/memoryDoc.js. Design: docs/11-MEMORY-ARCHITECTURE.md.';

-- ─── Part 2: episodic lifecycle — tombstones on user_memories ───────────────
-- The vector store is demoted to episodic recall; contradicted episodes stop
-- surfacing as if current. Additive, default false: nothing changes at
-- runtime until consolidation or the forget pipeline sets it.

alter table user_memories add column if not exists superseded boolean not null default false;
alter table user_memories add column if not exists superseding_fact uuid;

comment on column user_memories.superseded is
  'Tombstone: this episode is contradicted by a newer canonical fact (superseding_fact) or was covered by a user forget request. Excluded from retrieval; the row is kept for provenance.';

-- ─── Part 3: retrieval respects tombstones ──────────────────────────────────
-- Same signature and body as 008, plus the superseded guard, so this is a
-- pure re-create; callers are unchanged.

create or replace function match_user_memories(
  match_user_id text,
  query_embedding vector(384),
  match_count int default 10
)
returns table (
  id uuid,
  content text,
  type text,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  select
    um.id,
    um.content,
    um.type,
    (1 - (um.embedding <=> query_embedding))::float as similarity,
    um.created_at
  from user_memories um
  where um.user_id = match_user_id
    and um.embedding is not null
    and not um.superseded
  order by um.embedding <=> query_embedding
  limit match_count;
end;
$$;
