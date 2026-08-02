-- Self-heal columns for dev_build_requests + the circuit-breaker alert table.
--
-- Lets runDevBuildWorker re-pick failed rows BY CLASS instead of blanket
-- retrying: transient infra flakes back off and retry, stale-branch conflicts
-- regenerate once, and scope-fence / destructive-migration / forbidden failures
-- stay terminal (human only). pipeline_alerts collapses a repeating failure
-- into ONE alert instead of one per row.
--
-- Additive and idempotent: every statement is safe to re-run against a database
-- that already has this schema (deploy.yml re-applies all migration files on
-- every migration-touching push). No table, column or row is removed.

-- ─── Retry bookkeeping on dev_build_requests ─────────────────────────────────

alter table dev_build_requests
  add column if not exists attempts integer not null default 0;

alter table dev_build_requests
  add column if not exists next_retry_at timestamptz;

-- One of: transient | stale_branch | terminal. Null until a failure is classified.
alter table dev_build_requests
  add column if not exists failure_class text;

-- Normalised (stage + error) fingerprint. Rows failing the same way share one,
-- which is what the circuit breaker counts.
alter table dev_build_requests
  add column if not exists failure_signature text;

-- The worker's retry scan: status + due time.
create index if not exists dev_build_requests_retry_idx
  on dev_build_requests (status, next_retry_at);

-- The breaker's consecutive-failure scan.
create index if not exists dev_build_requests_failure_sig_idx
  on dev_build_requests (failure_signature, created_at desc);

-- ─── pipeline_alerts — one open alert per failure signature ──────────────────
-- Server-owned (service-role writes); no direct client access, same posture as
-- the 018 pipeline tables.

create table if not exists pipeline_alerts (
  id           uuid        primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  kind         text        not null,
  signature    text        not null,
  detail       jsonb       not null default '{}'::jsonb,
  resolved_at  timestamptz
);

-- The whole point of the breaker: a repeating failure raises ONE alert, not N.
-- A partial unique index enforces that at the database level, so a race between
-- two worker ticks cannot double-alert.
create unique index if not exists pipeline_alerts_open_signature_key
  on pipeline_alerts (signature)
  where resolved_at is null;

create index if not exists pipeline_alerts_created_idx
  on pipeline_alerts (created_at desc);

alter table pipeline_alerts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pipeline_alerts'
      and policyname = 'pipeline_alerts_service_only'
  ) then
    create policy pipeline_alerts_service_only on pipeline_alerts
      using (false)
      with check (false);
  end if;
end $$;

comment on table pipeline_alerts is
  'Circuit-breaker alerts: one open row per failure signature. Raised by devPipeline.js runDevBuildWorker when consecutive requests fail the same way; resolved_at set when the signature next succeeds.';
