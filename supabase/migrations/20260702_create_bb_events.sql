-- Transactional event store for deterministic usage stats
-- ("when was my last cigarette", "how many today"). Event types are
-- open-ended (stored as free text) so new ones can be added without
-- a schema migration: cigarette, urge_resisted, urge_gave_in, milestone,
-- session_start, etc.

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

-- user_id is free-text (not a uuid FK) because several server-side callers
-- write under a 'default' sentinel before a Supabase auth identity exists.
-- Those writes go through the server's service-role key, which bypasses RLS;
-- the policy below is defense-in-depth for any future direct client access.
alter table bb_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'bb_events' and policyname = 'bb_events: own rows only'
  ) then
    create policy "bb_events: own rows only"
      on bb_events for all
      using (auth.uid()::text = user_id)
      with check (auth.uid()::text = user_id);
  end if;
end $$;
