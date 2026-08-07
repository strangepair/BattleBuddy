-- Build train + releases grouping (submission 7, stage 1).
--
-- Three things this adds:
--
--  1. `releases` learns which Actions run built it, at which commit, and what
--     changelog it carries — so a release is identifiable from GitHub alone and
--     can be rebuilt by the reconciler if a callback is lost.
--  2. `changes` gains the missing join to `dev_build_requests`. `changes` has
--     been an empty table since migration 018 because nothing wrote it; it is
--     the link between a work item and the concrete PR that implements it, and
--     stage 2's reconciler is what finally populates it.
--  3. `dev_build_requests` gains its work item, its release, and an `expedite`
--     flag (stage 3), plus the `superseded` status a closed-unmerged PR needs.
--
-- Additive and idempotent: every statement is safe to re-run against a database
-- that already contains this schema (deploy.yml re-applies every migration file
-- on every migration-touching push). Additive only - this file never removes
-- tables, columns or rows. Constraints are only ever WIDENED, so rows that
-- satisfied the old check still satisfy the new one.

-- ─── releases — a build train run ────────────────────────────────────────────

alter table releases add column if not exists run_id       text;
alter table releases add column if not exists run_number   integer;
alter table releases add column if not exists commit_sha   text;
alter table releases add column if not exists changelog    text;
alter table releases add column if not exists started_at   timestamptz;
alter table releases add column if not exists completed_at timestamptz;
alter table releases add column if not exists platform     text not null default 'ios';

-- Set when a release bypassed the train because one request was expedited
-- (stage 3). Null for ordinary train builds.
alter table releases add column if not exists expedite_request_id uuid;

-- The Actions run id is the release's natural key: /dev/release/start,
-- /dev/release/complete and the reconciler all upsert on it, so a retried
-- callback or a reconciler backfill can never create a second row for one build.
create unique index if not exists releases_run_id_key on releases (run_id) where run_id is not null;

create index if not exists releases_status_idx on releases (status);

-- 'building' (train run started) and 'failed' (EAS build or submit did not
-- finish) join the original assembling/canary/live/partially_rolled_back set.
alter table releases drop constraint if exists releases_status_check;
alter table releases add constraint releases_status_check
  check (status in ('assembling','building','canary','live','failed','partially_rolled_back'));

comment on column releases.run_id is
  'GitHub Actions run id of the mobile-release.yml build. Natural key — every writer upserts on it, so a lost or duplicated callback cannot fork the row.';

-- ─── changes — the join between a work item and its PR ───────────────────────

alter table changes add column if not exists dev_request_id uuid references dev_build_requests (id);
alter table changes add column if not exists title          text;
alter table changes add column if not exists pr_url         text;
alter table changes add column if not exists merged_at      timestamptz;
alter table changes add column if not exists updated_at     timestamptz not null default now();

-- One change row per build request, and one per PR. Both are upsert keys for
-- the reconciler, which is stateless and re-derives this projection every tick.
create unique index if not exists changes_dev_request_key on changes (dev_request_id) where dev_request_id is not null;
create unique index if not exists changes_pr_number_key   on changes (pr_number)      where pr_number is not null;

-- A change can exist before triage has produced a work item for it — an adopted
-- hand-made PR is the common case — so the work item link becomes optional.
alter table changes alter column work_item_id drop not null;

-- Mirrors the dev_build_requests lifecycle so the two never disagree about the
-- same PR: in_review / deployed / failed / needs_attention join the 018 set.
alter table changes drop constraint if exists changes_status_check;
alter table changes add constraint changes_status_check
  check (status in ('building','pr_open','in_review','merged','deployed','failed',
                    'needs_attention','flag_off','canary','flag_on','rolled_back','superseded'));

comment on column changes.dev_request_id is
  'The dev_build_requests row this change implements. Written by the reconciler (server/devReconcile.js); this is the join that was missing while `changes` sat empty.';

-- ─── dev_build_requests — work item, release, expedite ───────────────────────

alter table dev_build_requests add column if not exists work_item_id uuid references work_items (id);
alter table dev_build_requests add column if not exists release_id   uuid references releases (id);

-- Stage 3: an expedited request dispatches mobile-release.yml under its own
-- concurrency group, so it builds alone instead of waiting for the train.
alter table dev_build_requests add column if not exists expedite boolean not null default false;

-- Last time the reconciler compared this row against GitHub. Lets the tick
-- prioritise rows it has not looked at recently, and makes staleness visible.
alter table dev_build_requests add column if not exists reconciled_at timestamptz;

create index if not exists dev_build_requests_release_idx    on dev_build_requests (release_id);
create index if not exists dev_build_requests_work_item_idx  on dev_build_requests (work_item_id);
create index if not exists dev_build_requests_pr_number_idx  on dev_build_requests (pr_number);
create index if not exists dev_build_requests_reconciled_idx on dev_build_requests (reconciled_at);

-- 'superseded' is what a closed-but-not-merged PR derives to. Before this there
-- was no honest state for it, so those rows sat at their last pushed status
-- (usually in_review) forever — one of the drifts this submission removes.
--
-- THIS FILE IS THE SOLE DEFINITION of dev_build_requests_status_check. 021 used
-- to define it too, with a narrower list, and re-narrowed it on every pass until
-- a 'superseded' row made that fail and deadlocked every migration above 021.
-- To add a status, widen the list HERE — never in a new file, or this one
-- becomes the narrowing next time. Enforced by tests/migration-safety.test.js.
--
-- Wrapped in a transaction because psql autocommits statement by statement: on
-- 2026-08-05 a DROP committed and its ADD failed, leaving the live table with no
-- status constraint at all. A violated ADD must take the DROP down with it.
begin;
alter table dev_build_requests drop constraint if exists dev_build_requests_status_check;
alter table dev_build_requests add constraint dev_build_requests_status_check
  check (status in ('pending','building','in_review','merging','deploying',
                    'deployed','failed','needs_attention','duplicate','superseded'));
commit;

-- 'github' is the source for a request the reconciler adopted from a PR nobody
-- submitted through the app (a hand-made or agent-authored branch). Mike's rule
-- is that every change is tracked in dev_build_requests; adoption is how a
-- direct PR — including the ones shipping this submission — gets a row.
--
-- 'design-loop' is the agent design loop's proposed system-prompt tuning
-- (server/agentDesignLoop.js → server/promptPr.js). It used to write the live
-- prompt directly, with no PR and no review; it now opens a PR and files the
-- row this value labels, so the proposal is reviewed and merged like anything
-- else. Same rule as the status check above: THIS FILE IS THE SOLE DEFINITION
-- of dev_build_requests_source_check — widen the list HERE, never in a new
-- file, or that file becomes the narrowing on the next deploy.
begin;
alter table dev_build_requests drop constraint if exists dev_build_requests_source_check;
alter table dev_build_requests add constraint dev_build_requests_source_check
  check (source in ('transcript','directive','github','design-loop'));
commit;

comment on column dev_build_requests.expedite is
  'Bypass the mobile build train: dispatch mobile-release.yml under a unique concurrency group so this one change builds immediately and alone.';

-- ─── pipeline_events — kinds the reconciler emits ────────────────────────────

alter table pipeline_events drop constraint if exists pipeline_events_kind_check;
alter table pipeline_events add constraint pipeline_events_kind_check
  check (kind in ('submitted','understood','planned','build_started','pr_opened',
                  'merged','canary_started','went_live','rolled_back','refined',
                  'exception_raised','exception_resolved',
                  'released','deployed','superseded','reconciled'));
