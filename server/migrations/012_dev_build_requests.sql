-- Developer-mode build pipeline: one row per product request generated from a
-- dev-mode transcript or a typed directive, tracked through code → PR → deploy.
-- Server-owned (written via the service-role key). RLS on with no policy so the
-- anon key can't read it; the trusted server process bypasses RLS. Additive and
-- idempotent — safe to re-run.

create table if not exists dev_build_requests (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  source        text not null check (source in ('transcript', 'directive')),
  user_id       text,
  session_id    text,

  title         text not null,
  target        text not null check (target in ('backend', 'agent', 'ui', 'prompt')),
  description   text,
  spec          jsonb not null default '{}'::jsonb,
  confidence    real,

  -- pipeline state:
  -- pending → building → in_review → merging → deploying → deployed
  --                    ↘ failed | needs_attention
  status        text not null default 'pending'
                check (status in ('pending','building','in_review','merging',
                                  'deploying','deployed','failed','needs_attention')),

  branch        text,
  github_run_id text,
  pr_number     integer,
  pr_url        text,
  checks_status text,
  deploy_status text,
  error         text,

  dedupe_key    text,               -- hash of (target|normalized title) to skip repeats
  history       jsonb not null default '[]'::jsonb   -- [{at, from, to, note}]
);

create index if not exists dev_build_requests_status_idx  on dev_build_requests (status);
create index if not exists dev_build_requests_created_idx on dev_build_requests (created_at desc);
create index if not exists dev_build_requests_dedupe_idx  on dev_build_requests (dedupe_key);

alter table dev_build_requests enable row level security;
-- No policies: service-role (server) bypasses RLS; anon/auth get nothing.
