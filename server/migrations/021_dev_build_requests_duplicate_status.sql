-- Widen the dev_build_requests status check to allow 'duplicate'.
--
-- 'duplicate' is the terminal state for a build request whose submission triage
-- classified as a duplicate of an existing work item. runDevBuildWorker only
-- selects rows with status = 'pending', so a parked row is never dispatched and
-- never retried — that is what stops a duplicate submission from shipping a
-- second, identical build. Written by holdDuplicateRequests in devPipeline.js.
--
-- Renumbered 019 → 021 on 2026-08-02: two agents working in parallel both took
-- 019. The pair was independent so nothing broke, but the collision guard in
-- server/tests/migration-safety.test.js now forbids it. Renumbering is safe
-- precisely because this file is idempotent — re-running it later is a no-op.
--
-- ─── 2026-08-05: this file deadlocked the entire migration plane ─────────────
--
-- deploy.yml re-applies EVERY migration file on every migration-touching push,
-- in numeric order. This file used to `drop constraint … ; add constraint …`
-- unconditionally, which meant that on each deploy it REPLACED the wider
-- constraint installed by 022 (which added 'superseded') with its own narrower
-- list. That was harmless until a row actually held status 'superseded' — the
-- backlog clear created 32 of them — and from then on this file failed with
--
--     ERROR: check constraint "dev_build_requests_status_check" of relation
--            "dev_build_requests" is violated by some row
--
-- aborting the migration job before 022 and 023 could run. Nothing after this
-- file could ever be applied again: a permanent deadlock, from a file whose own
-- header promised "the constraint is only ever widened".
--
-- THE RULE, now enforced by migration-safety.test.js: for any named constraint,
-- only the LAST file that defines it may drop-and-add unconditionally. Every
-- earlier definition must be conditional, so it cannot narrow what a later file
-- widened. When you add a new widening file, guard the previous one.
--
-- Additive and idempotent — safe to re-run. No table, column or row is removed.

do $$
begin
  -- Only install this list if no status constraint exists at all (a fresh
  -- database, or one where the constraint was dropped by hand). If 022's wider
  -- list is already in place, this is a no-op — never a narrowing.
  if not exists (
    select 1 from pg_constraint
     where conname = 'dev_build_requests_status_check'
       and conrelid = 'dev_build_requests'::regclass
  ) then
    alter table dev_build_requests
      add constraint dev_build_requests_status_check
      check (status in ('pending','building','in_review','merging',
                        'deploying','deployed','failed','needs_attention','duplicate'));
  end if;
end $$;
