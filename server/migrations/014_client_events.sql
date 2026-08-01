-- Client-side telemetry events — lightweight sink for device-reported
-- diagnostic events (e.g. voice output failures) so the server has
-- visibility without exposing conversation content.
--
-- Additive and idempotent: every statement is safe to re-run against a
-- database that already contains this schema (deploy.yml re-runs all
-- migration files on every change).

create table if not exists client_events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     text        not null,
  session_id  text        not null,
  event_type  text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists client_events_user_type
  on client_events (user_id, event_type);

create index if not exists client_events_created
  on client_events (created_at desc);

alter table client_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'client_events' and policyname = 'own_client_events'
  ) then
    create policy own_client_events on client_events
      using (auth.uid()::text = user_id)
      with check (auth.uid()::text = user_id);
  end if;
end $$;

comment on table client_events is
  'Device-reported diagnostic events (voice failures, etc.). Inserted by the server on behalf of the authenticated user; never contains conversation content. Design: server/index.js POST /events/voice-failure.';
