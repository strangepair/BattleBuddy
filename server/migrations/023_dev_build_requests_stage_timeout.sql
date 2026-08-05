-- Stage clock for dev_build_requests — no pipeline state may be permanent.
--
-- Every in-flight state (building, in_review, merging, deploying) is a claim
-- that GitHub still owes this pipeline a transition, and every one of those
-- claims can be lost: a status callback that 404s, an Actions run cancelled,
-- an auto-merge that disarms on a conflict, a release that never goes live.
-- A lost transition costs a concurrency slot FOREVER — PR #124 held the only
-- slot at `merging` until a human noticed, and on 2026-08-05 eleven rows whose
-- PRs had already merged held every slot for an afternoon.
--
--   entered_at   — when the row took its CURRENT state. updated_at cannot
--                  serve: any unrelated write (a reconciler touch, an archive)
--                  would reset the stage's TTL and the row would never age out.
--   timed_out_at — set when the stage-timeout sweep retires a row. Also the
--                  marker the reconciler reads so it cannot drag a retired row
--                  back into an in-flight state on the next tick.
--
-- Additive and idempotent: every statement is safe to re-run against a database
-- that already has this schema (deploy.yml re-applies every migration file on
-- every migration-touching push). Additive only — this file never removes a
-- table, column or row. The one UPDATE is guarded on `is null`, so a re-run
-- touches nothing.

alter table dev_build_requests
  add column if not exists entered_at timestamptz;

alter table dev_build_requests
  add column if not exists timed_out_at timestamptz;

-- Backfill: for every transition the pipeline has ever written, updated_at IS
-- the moment the row took its current state. Deliberately not `now()` — that
-- would hand every existing ghost a fresh TTL and hide exactly the rows this
-- migration exists to retire.
update dev_build_requests
   set entered_at = coalesce(updated_at, created_at)
 where entered_at is null;

-- New rows are stamped by the database, so a row created outside setStatus
-- (adoption, a hand-inserted traceability row) still has a stage clock.
alter table dev_build_requests
  alter column entered_at set default now();

-- The sweep's scan: in-flight rows, oldest stage first.
create index if not exists dev_build_requests_stage_clock_idx
  on dev_build_requests (status, entered_at);

comment on column dev_build_requests.entered_at is
  'When the row took its current status. Read by the stage-timeout sweep in server/devPipeline.js; reset by every status change (setStatus, applyPatch), never by an unrelated write.';

comment on column dev_build_requests.timed_out_at is
  'Set when a stage timeout retired this row to needs_attention and released its concurrency slot. While set, the reconciler may update the row''s PR/branch/checks and may move it to a TERMINAL state, but may not put it back in flight.';
