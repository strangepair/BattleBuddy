-- ONE-PASTE APPLY FILE — run this whole file once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).
-- Combines the two pending migrations; safe to re-run.
--   1) 20260702_create_bb_events.sql  — transactional event store
--   2) 20260703_identity_alignment.sql — push_tokens accepts local text ids
-- Delete this file after applying (the canonical copies live in migrations/).

-- ── 1. bb_events ─────────────────────────────────────────────────────────────
create table if not exists bb_events (
  id           uuid default gen_random_uuid() primary key,
  user_id      text not null,
  event_type   text not null,
  occurred_at  timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_bb_events_user_date on bb_events(user_id, occurred_at desc);
create index if not exists idx_bb_events_user_type on bb_events(user_id, event_type, occurred_at desc);

alter table bb_events enable row level security;

drop policy if exists "bb_events: own rows only" on bb_events;
create policy "bb_events: own rows only"
  on bb_events for all
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

-- ── 2. push_tokens identity alignment ────────────────────────────────────────
alter table public.push_tokens drop constraint if exists push_tokens_user_id_fkey;
alter table public.push_tokens alter column user_id type text using user_id::text;

drop policy if exists "push_tokens: own rows only" on public.push_tokens;
create policy "push_tokens: own rows only"
  on public.push_tokens for all
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);
