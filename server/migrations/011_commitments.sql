-- Inferred commitments — content-derived reasons to reach out later.
--
-- BattleBuddy's proactive contact (runNudgeSweep) fires on learned time-of-day
-- risk windows. A commitment is the other kind: a specific forward-looking
-- follow-up inferred from what was actually said in a session ("they said
-- they'd try the gym Tuesday"). Delivery rides the same nudge sweep and inherits
-- its rails; this table just holds the pending follow-ups.
--
-- Gated behind COMMITMENTS_ENABLED (default off). Nothing writes here until Mike
-- turns it on after reviewing real candidates — same propose-then-approve
-- posture as the design loop. Scoring/gating logic lives in server/commitments.js.
--
-- Run via Supabase SQL Editor or psql.

create table if not exists user_commitments (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  kind text not null check (kind in ('event_check_in', 'deadline_check', 'open_loop', 'care_check_in')),
  summary text not null,
  -- Stable slug ('gym-tuesday'). Unique per user among open commitments so the
  -- same follow-up inferred across two sessions doesn't queue twice — enforced
  -- by the partial unique index below, not just app-side dedupe.
  dedupe_key text not null,
  confidence real not null,
  -- Earliest a delivery may be *considered*. Always at least one nudge interval
  -- past creation, so a follow-up can never fire in the session it was inferred.
  due_after timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dismissed', 'expired')),
  source_session text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

-- Delivery scan: this user's pending, now-due commitments.
create index if not exists user_commitments_due_idx
  on user_commitments (user_id, due_after)
  where status = 'pending';

-- One open commitment per (user, dedupe_key). A repeat inference updates nothing
-- rather than stacking duplicates; the app treats the insert conflict as "already
-- queued." Scoped to pending so a delivered follow-up can legitimately recur later.
create unique index if not exists user_commitments_open_key_idx
  on user_commitments (user_id, dedupe_key)
  where status = 'pending';

-- RLS on every table, per the project's standing rule (CLAUDE.md rule 4).
-- bb-server uses the service role and bypasses RLS; this policy governs any
-- future direct client access once Supabase Auth is wired (see the 2026-07-06
-- note in DECISIONS.md about the local-id / uuid-RLS gap).
alter table user_commitments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'user_commitments' and policyname = 'own_commitments'
  ) then
    create policy own_commitments on user_commitments
      using (auth.uid()::text = user_id)
      with check (auth.uid()::text = user_id);
  end if;
end $$;

comment on table user_commitments is
  'Inferred forward-looking follow-ups, delivered via runNudgeSweep. Off unless COMMITMENTS_ENABLED=true. Logic in server/commitments.js.';
