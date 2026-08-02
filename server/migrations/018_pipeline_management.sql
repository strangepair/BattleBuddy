-- Pipeline management data layer — submissions, work items, changes, releases,
-- and an append-only event feed for the card timeline.
--
-- Additive and idempotent: every statement is safe to re-run against a
-- database that already contains this schema (deploy.yml re-runs all
-- migration files on every change). No DROP / TRUNCATE / DELETE.

-- ─── submissions — raw user input ────────────────────────────────────────────

create table if not exists submissions (
  id          uuid        primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  source      text        not null check (source in ('voice','text','dev_mode','refine','exception_reply')),
  raw_text    text        not null,
  session_id  text
);

create index if not exists submissions_created
  on submissions (created_at desc);

alter table submissions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'submissions' and policyname = 'submissions_service_only'
  ) then
    create policy submissions_service_only on submissions
      using (false)
      with check (false);
  end if;
end $$;

comment on table submissions is
  'Raw user input captured by the pipeline. Server-owned (service-role writes); no direct client access. Design: server/migrations/018_pipeline_management.sql.';

-- ─── work_items — normalised unit of work ────────────────────────────────────

create table if not exists work_items (
  id                   uuid        primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  title                text        not null,
  interpretation       text,
  subsystem            text        not null default 'other'
                       check (subsystem in ('voice','calendar','logging','dashboard','pipeline','other')),
  stage                text        not null default 'received'
                       check (stage in ('received','understood','planned','building','verifying',
                                        'canary','live','rolled_back','archived')),
  parent_work_item_id  uuid        references work_items (id),
  exception            jsonb
);

create index if not exists work_items_stage
  on work_items (stage);

create index if not exists work_items_created
  on work_items (created_at desc);

alter table work_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'work_items' and policyname = 'work_items_service_only'
  ) then
    create policy work_items_service_only on work_items
      using (false)
      with check (false);
  end if;
end $$;

comment on table work_items is
  'Normalised unit of work derived from one or more submissions. Tracks the item through the full pipeline lifecycle. Design: server/migrations/018_pipeline_management.sql.';

-- ─── work_item_submissions — many-to-many join ───────────────────────────────

create table if not exists work_item_submissions (
  work_item_id  uuid  not null references work_items  (id),
  submission_id uuid  not null references submissions  (id),
  role          text  not null check (role in ('origin','evidence','refinement')),
  primary key (work_item_id, submission_id)
);

create index if not exists wis_submission
  on work_item_submissions (submission_id);

alter table work_item_submissions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'work_item_submissions' and policyname = 'wis_service_only'
  ) then
    create policy wis_service_only on work_item_submissions
      using (false)
      with check (false);
  end if;
end $$;

comment on table work_item_submissions is
  'Join table attaching submissions to work items. Multiple reports of the same symptom can reference one work item with role=evidence.';

-- ─── releases — versioned batch container ────────────────────────────────────

create table if not exists releases (
  id         uuid    primary key default gen_random_uuid(),
  version    integer not null unique,
  created_at timestamptz not null default now(),
  status     text    not null default 'assembling'
             check (status in ('assembling','canary','live','partially_rolled_back')),
  notes      text
);

create index if not exists releases_version
  on releases (version desc);

alter table releases enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'releases' and policyname = 'releases_service_only'
  ) then
    create policy releases_service_only on releases
      using (false)
      with check (false);
  end if;
end $$;

comment on table releases is
  'Versioned batch container grouping one or more changes into a deployable release.';

-- ─── changes — concrete implementation of a work item ────────────────────────

create table if not exists changes (
  id            uuid    primary key default gen_random_uuid(),
  work_item_id  uuid    not null references work_items (id),
  created_at    timestamptz not null default now(),
  branch        text,
  pr_number     integer,
  flag_key      text,
  status        text    not null default 'building'
                check (status in ('building','pr_open','merged','flag_off','canary',
                                  'flag_on','rolled_back','superseded')),
  release_id    uuid    references releases (id)
);

create index if not exists changes_work_item
  on changes (work_item_id);

create index if not exists changes_release
  on changes (release_id);

create index if not exists changes_status
  on changes (status);

alter table changes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'changes' and policyname = 'changes_service_only'
  ) then
    create policy changes_service_only on changes
      using (false)
      with check (false);
  end if;
end $$;

comment on table changes is
  'Concrete implementation unit for a work item: branch, PR, feature flag, and deployment status.';

-- ─── pipeline_events — append-only timeline feed ─────────────────────────────

create table if not exists pipeline_events (
  id            uuid    primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  kind          text    not null
                check (kind in ('submitted','understood','planned','build_started','pr_opened',
                                'merged','canary_started','went_live','rolled_back','refined',
                                'exception_raised','exception_resolved')),
  work_item_id  uuid    not null references work_items (id),
  change_id     uuid    references changes (id),
  release_id    uuid    references releases (id),
  detail        jsonb   not null default '{}'::jsonb
);

create index if not exists pipeline_events_work_item
  on pipeline_events (work_item_id, created_at desc);

create index if not exists pipeline_events_created
  on pipeline_events (created_at desc);

alter table pipeline_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pipeline_events' and policyname = 'pipeline_events_service_only'
  ) then
    create policy pipeline_events_service_only on pipeline_events
      using (false)
      with check (false);
  end if;
end $$;

comment on table pipeline_events is
  'Append-only event feed powering the pipeline card timeline. Inserted by POST /api/pipeline/events (server-internal). Design: server/migrations/018_pipeline_management.sql.';
