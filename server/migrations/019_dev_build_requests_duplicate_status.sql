-- Widen the dev_build_requests status check to allow 'duplicate'.
--
-- 'duplicate' is the terminal state for a build request whose submission triage
-- classified as a duplicate of an existing work item. runDevBuildWorker only
-- selects rows with status = 'pending', so a parked row is never dispatched and
-- never retried — that is what stops a duplicate submission from shipping a
-- second, identical build. Written by holdDuplicateRequests in devPipeline.js.
--
-- Additive and idempotent — safe to re-run. No table, column or row is removed;
-- the constraint is only ever widened, so existing rows always still satisfy it.

alter table dev_build_requests
  drop constraint if exists dev_build_requests_status_check;

alter table dev_build_requests
  add constraint dev_build_requests_status_check
  check (status in ('pending','building','in_review','merging',
                    'deploying','deployed','failed','needs_attention','duplicate'));
