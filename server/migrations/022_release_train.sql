-- Release train: one EAS build produces one `releases` row grouping every
-- change it carried.
--
-- The mobile build is serialised by GitHub Actions concurrency
-- (.github/workflows/mobile-release.yml), so a build can batch many merges.
-- Superseded pending runs never execute and never post a status callback,
-- which means the release — not the deploy workflow — is what marks those
-- requests deployed. These columns are what makes that possible.
--
-- Additive and idempotent: safe to re-run against a database that already has
-- this schema. No table, column or row is removed; the changes.status
-- constraint is only ever widened.

-- ─── releases: what a build actually shipped ─────────────────────────────────

alter table releases add column if not exists build_number integer;
alter table releases add column if not exists head_sha     text;
alter table releases add column if not exists base_sha     text;
alter table releases add column if not exists changelog    jsonb not null default '[]'::jsonb;
alter table releases add column if not exists completed_at timestamptz;

-- One release per TestFlight build. Partial so pre-train rows (no build number)
-- don't collide with each other.
create unique index if not exists releases_build_number_key
  on releases (build_number)
  where build_number is not null;

-- ─── dev_build_requests: which release carried this change ───────────────────

alter table dev_build_requests add column if not exists release_id uuid;

create index if not exists dev_build_requests_release_idx
  on dev_build_requests (release_id);

-- ─── changes: the missing join between work_items and dev_build_requests ─────
-- Nothing has ever written this table, which is why the work-items view never
-- reflected what was actually building. The release path (and the stage-2
-- reconciler) populate it.

-- A PR that never went through triage has no work item. Before this, such a
-- row could not exist at all, so those PRs stayed invisible.
alter table changes alter column work_item_id drop not null;

alter table changes add column if not exists dev_build_request_id uuid;
alter table changes add column if not exists title                text;
alter table changes add column if not exists merge_sha            text;

-- Makes the reconciler's per-PR upsert idempotent.
create unique index if not exists changes_pr_number_key
  on changes (pr_number)
  where pr_number is not null;

create index if not exists changes_dev_build_request_idx
  on changes (dev_build_request_id);

-- 'deployed' is the state a change reaches once a release carries it to
-- TestFlight. Widening only — every existing row still satisfies the check.
alter table changes drop constraint if exists changes_status_check;

alter table changes
  add constraint changes_status_check
  check (status in ('building','pr_open','merged','flag_off','canary',
                    'flag_on','rolled_back','superseded','deployed'));

comment on column releases.changelog is
  'Auto-generated: { headline: "Build N — M changes", items: [{title, pr_number, request_id}] }. Rendered as the release-grouped view on the pipeline screen.';
