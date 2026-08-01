-- Activity/routine log — tracks named activities alongside cigarette events.
-- Additive and idempotent — safe to re-run against a database that already
-- has this table. Does not alter or drop any existing table or column.

create table if not exists activities (
  id            uuid        primary key default gen_random_uuid(),
  user_id       text        not null,
  activity_name text        not null,
  start_time    timestamptz not null,
  end_time      timestamptz,
  location      text,
  created_at    timestamptz not null default now()
);

create index if not exists activities_user_start
  on activities (user_id, start_time desc);

alter table activities enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'activities' and policyname = 'own_activities'
  ) then
    create policy own_activities on activities
      using  (auth.uid()::text = user_id)
      with check (auth.uid()::text = user_id);
  end if;
end $$;

comment on table activities is
  'User activity/routine log: named events with start/end times, stored alongside bb_events (cigarette). Written by POST /logs/activity; read by GET /logs.';
