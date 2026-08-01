-- Add archived column to dev_build_requests for non-destructive soft-archiving.
-- Additive and idempotent — safe to re-run.

alter table dev_build_requests
  add column if not exists archived boolean not null default false;

create index if not exists dev_build_requests_archived_idx on dev_build_requests (archived);
