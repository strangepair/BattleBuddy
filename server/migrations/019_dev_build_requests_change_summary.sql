-- Add change_summary column to dev_build_requests for PR card display.
-- Nullable text; existing rows return null without error.
-- Additive and idempotent — safe to re-run.

alter table dev_build_requests
  add column if not exists change_summary text;
