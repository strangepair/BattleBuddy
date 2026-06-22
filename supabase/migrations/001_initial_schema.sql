-- BattleBuddy initial schema
-- All tables are per-user with Row-Level Security enforced.
-- Run in Supabase SQL editor or via supabase db push.

-- ─── Extensions ────────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── Users (extends Supabase auth.users) ───────────────────────────────────────
create table public.users (
  id             uuid primary key references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  display_name   text,
  habit_target   text not null default 'smoking',  -- MVP: always 'smoking'
  onboarding_profile jsonb not null default '{}',  -- goals, triggers, preferred tone
  consent_flags  jsonb not null default '{}'
);

alter table public.users enable row level security;

create policy "users: own row only"
  on public.users for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create a users row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Craving events ─────────────────────────────────────────────────────────────
create table public.craving_events (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id) on delete cascade,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  trigger_context jsonb not null default '{}',  -- time, place, mood, what set it off
  mode            text not null default 'text' check (mode in ('text', 'voice')),
  outcome         text check (outcome in ('resisted', 'submitted', 'unsure')),
  helped          boolean,
  intensity_start smallint check (intensity_start between 0 and 10),
  intensity_end   smallint check (intensity_end between 0 and 10)
);

alter table public.craving_events enable row level security;

create policy "craving_events: own rows only"
  on public.craving_events for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index on public.craving_events (user_id, started_at desc);

-- ─── Messages ───────────────────────────────────────────────────────────────────
create table public.messages (
  id               uuid primary key default uuid_generate_v4(),
  craving_event_id uuid not null references public.craving_events(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null,
  created_at       timestamptz not null default now(),
  media_id         uuid,  -- nullable, references media_library
  modality         text not null default 'text' check (modality in ('text', 'voice'))
);

alter table public.messages enable row level security;

create policy "messages: own rows only"
  on public.messages for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index on public.messages (craving_event_id, created_at asc);

-- ─── Media library ──────────────────────────────────────────────────────────────
-- Seeded by admins; readable by all authenticated users.
create table public.media_library (
  id       uuid primary key default uuid_generate_v4(),
  type     text not null check (type in ('song', 'video', 'image', 'exercise')),
  title    text not null,
  url      text not null,  -- Cloudflare R2 URL or external
  tags     text[] not null default '{}',
  framing  text not null check (framing in ('encouragement', 'consequences', 'distraction', 'education'))
);

alter table public.media_library enable row level security;

create policy "media_library: authenticated read"
  on public.media_library for select
  using (auth.role() = 'authenticated');

-- ─── User media stats ───────────────────────────────────────────────────────────
create table public.user_media_stats (
  user_id          uuid not null references public.users(id) on delete cascade,
  media_id         uuid not null references public.media_library(id) on delete cascade,
  shown_count      int not null default 0,
  engaged_seconds  int not null default 0,
  resisted_after   int not null default 0,
  submitted_after  int not null default 0,
  primary key (user_id, media_id)
);

alter table public.user_media_stats enable row level security;

create policy "user_media_stats: own rows only"
  on public.user_media_stats for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── User framing stats ─────────────────────────────────────────────────────────
create table public.user_framing_stats (
  user_id       uuid not null references public.users(id) on delete cascade,
  framing       text not null check (framing in ('encouragement', 'consequences', 'distraction', 'education')),
  shown_count   int not null default 0,
  resisted_after int not null default 0,
  primary key (user_id, framing)
);

alter table public.user_framing_stats enable row level security;

create policy "user_framing_stats: own rows only"
  on public.user_framing_stats for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── Risk windows ───────────────────────────────────────────────────────────────
-- MVP: seeded from onboarding answers. Phase 3+: learned from events.
create table public.risk_windows (
  user_id     uuid not null references public.users(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),  -- 0=Sun
  hour        smallint not null check (hour between 0 and 23),
  weight      real not null default 1.0,
  primary key (user_id, day_of_week, hour)
);

alter table public.risk_windows enable row level security;

create policy "risk_windows: own rows only"
  on public.risk_windows for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
