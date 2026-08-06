-- Widen the dev_build_requests status check to allow 'duplicate'.
--
-- ⚠ THIS FILE IS NOW A DOCUMENTED NO-OP. The constraint it used to define is
-- defined by 022_build_train_releases.sql, which runs immediately after it in
-- every migration pass and whose list is a strict superset. Read on before
-- adding a statement here.
--
-- 'duplicate' is the terminal state for a build request whose submission triage
-- classified as a duplicate of an existing work item. runDevBuildWorker only
-- selects rows with status = 'pending', so a parked row is never dispatched and
-- never retried — that is what stops a duplicate submission from shipping a
-- second, identical build. Written by holdDuplicateRequests in devPipeline.js.
--
-- ─── 2026-08-05: this file deadlocked the entire migration plane ─────────────
--
-- deploy.yml re-applies EVERY migration file on every migration-touching push,
-- in numeric order. This file used to `drop constraint … ; add constraint …`
-- unconditionally, so on each pass it REPLACED the wider constraint installed
-- by 022 (which adds 'superseded') with its own narrower list. Harmless until a
-- row actually held 'superseded' — the backlog clear created 32 — and from then
-- on this file failed with
--
--     ERROR: check constraint "dev_build_requests_status_check" of relation
--            "dev_build_requests" is violated by some row
--
-- ON_ERROR_STOP aborted the job before 022 and 023 could run. Nothing numbered
-- above this file could ever be applied again: a permanent deadlock, from a
-- file whose own header promised "the constraint is only ever widened".
--
-- Worse, psql autocommits each statement: the DROP succeeded and the ADD failed,
-- so the live database was left with NO status constraint at all. That is why
-- 022 now wraps its drop-and-add in a transaction — a violated ADD must roll the
-- DROP back rather than leave the table unconstrained.
--
-- THE RULE, enforced by server/tests/migration-safety.test.js: for any named
-- constraint, exactly ONE file may define it — the last one. A widening does not
-- get a new definition in a new file unless the older one is removed, because
-- the older definition re-narrows the constraint on every subsequent deploy.
--
-- To add a status: widen the check in 022 (and add it to the status union in
-- server/devPipeline.js). Do not add a statement to this file.
--
-- Additive and idempotent — safe to re-run. It does nothing at all.

do $$
begin
  -- Intentionally empty. See the header: 022_build_train_releases.sql owns
  -- dev_build_requests_status_check, and its list already contains 'duplicate'.
  null;
end $$;
