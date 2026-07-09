-- User profile store (replaces the Railway-volume JSON files at
-- context-store/{userId}.json) + dynamic alias table (replaces the
-- hardcoded USER_ALIASES map as the sole source of truth going forward —
-- the map in contextAgent.js remains a bootstrap seed / offline fallback).
-- Run via Supabase SQL Editor or psql
--
-- No RLS: all reads/writes go through bb-server with the service role key,
-- same as bb_events and user_memories. Add RLS once real Supabase Auth
-- covers every user.

create table if not exists user_profiles (
  user_id text primary key,
  profile jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists user_aliases (
  alias_id text primary key,
  canonical_id text not null
);
