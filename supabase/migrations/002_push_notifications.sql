-- Push notification infrastructure: tokens + per-user notification preferences.

-- ─── Push tokens ────────────────────────────────────────────────────────────────
create table public.push_tokens (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.users(id) on delete cascade,
  token      text not null,
  platform   text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  unique(user_id, token)
);

alter table public.push_tokens enable row level security;

create policy "push_tokens: own rows only"
  on public.push_tokens for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── Notification preferences ───────────────────────────────────────────────────
create table public.notification_preferences (
  user_id           uuid primary key references public.users(id) on delete cascade,

  -- Nudge type toggles
  check_in_enabled  boolean not null default true,
  streak_enabled    boolean not null default true,
  re_engage_enabled boolean not null default true,

  -- Up to 2 scheduled check-in times (stored as time-of-day, user's local zone)
  check_in_time_1   time default '13:00',  -- after lunch
  check_in_time_2   time default '19:00',  -- evening

  -- Quiet hours (no notifications between these times)
  quiet_start        time not null default '22:00',
  quiet_end          time not null default '08:00',

  -- Timezone (IANA, needed to evaluate times server-side)
  timezone           text not null default 'America/New_York',

  updated_at         timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

create policy "notification_preferences: own row only"
  on public.notification_preferences for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-create default preferences when a user row is created
create or replace function public.handle_new_user_preferences()
returns trigger language plpgsql security definer as $$
begin
  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_user_created_prefs
  after insert on public.users
  for each row execute function public.handle_new_user_preferences();
