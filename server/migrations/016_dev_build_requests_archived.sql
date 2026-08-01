-- Additive, non-destructive: add archived flag to dev_build_requests so the
-- Dev-dashboard "Archive" swipe action can hide completed/irrelevant cards
-- without deleting rows. Existing rows default to false (not archived).
-- Safe to re-run (ALTER TABLE … ADD COLUMN IF NOT EXISTS).

alter table dev_build_requests
  add column if not exists archived boolean not null default false;

create index if not exists dev_build_requests_archived_idx
  on dev_build_requests (archived);
