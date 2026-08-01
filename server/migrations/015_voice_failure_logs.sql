-- Voice mode failure logs — dedicated table for voice-failure events posted
-- by the client via POST /events/voice-failure.
--
-- Additive and idempotent: every statement uses IF NOT EXISTS so it is safe
-- to re-run against a database that already contains this schema.

create table if not exists voice_failure_logs (
  id          uuid        primary key default gen_random_uuid(),
  session_id  text        not null,
  user_id     text        not null,
  occurred_at timestamptz not null,
  reason      text,
  created_at  timestamptz not null default now()
);

create index if not exists voice_failure_logs_user
  on voice_failure_logs (user_id);

create index if not exists voice_failure_logs_created
  on voice_failure_logs (created_at desc);
