-- Layer 4: Longitudinal quit-journey data model
-- Stores years of history segmented by journey phase so the agent can
-- compare the current moment against the user's own past patterns.

-- ─── Journey phases ─────────────────────────────────────────────────────────────
-- Each phase is a contiguous period of a particular behavior pattern.
-- Phases are created/updated by the batch profiler, not by real-time events.
create table public.journey_phases (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references public.users(id) on delete cascade,
  phase_type    text not null check (phase_type in (
    'active_resistance',  -- actively resisting urges, engaging with the app
    'relapse',            -- period of giving in (smoking/vaping resumed)
    'tapering',           -- reducing frequency, partial control
    'dormant',            -- not engaging with the app, status unknown
    'stable'              -- long stretch of resistance, low urge frequency
  )),
  started_at    timestamptz not null,
  ended_at      timestamptz,  -- null = current phase
  event_count   int not null default 0,
  resist_count  int not null default 0,
  submit_count  int not null default 0,
  avg_intensity real,
  notes         text  -- batch profiler can annotate ("triggered by job change")
);

alter table public.journey_phases enable row level security;

create policy "journey_phases: own rows only"
  on public.journey_phases for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index on public.journey_phases (user_id, started_at desc);

-- ─── Context profiles ───────────────────────────────────────────────────────────
-- The compact artifact written by the batch profiler.
-- Read cheaply by the real-time agent — never recomputed on the hot path.
create table public.user_context_profiles (
  user_id         uuid primary key references public.users(id) on delete cascade,
  updated_at      timestamptz not null default now(),

  -- Pre-computed summary the LLM reads directly
  profile_text    text not null default 'New user — no history yet.',

  -- Structured data for programmatic use
  journey_position text,               -- "Day 14 of active resistance"
  current_phase_id uuid references public.journey_phases(id),
  risk_fingerprint jsonb default '{}', -- { time_risks: [...], trigger_risks: [...] }
  what_works       jsonb default '{}', -- { framings: [...], coping_styles: [...] }
  trajectory       text,               -- "improving", "stable", "declining"
  baseline         jsonb default '{}', -- { resting_hr: 72, daily_steps: 6000, ... }

  -- Batch metadata
  batch_version    int not null default 0,
  events_processed int not null default 0
);

alter table public.user_context_profiles enable row level security;

create policy "user_context_profiles: own row only"
  on public.user_context_profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── Biometric events (cloud mirror of on-device data) ──────────────────────────
-- Only anonymized/aggregated data syncs here. Raw values stay on-device.
create table public.biometric_anomalies (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references public.users(id) on delete cascade,
  signal_type   text not null,    -- heart_rate, steps, sleep, hrv
  anomaly_level text not null,    -- respond_now, hold_and_watch
  value         real,
  baseline      real,
  timestamp     timestamptz not null,
  engagement_result text          -- self_engaged, nudge_sent, expired
);

alter table public.biometric_anomalies enable row level security;

create policy "biometric_anomalies: own rows only"
  on public.biometric_anomalies for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index on public.biometric_anomalies (user_id, timestamp desc);
