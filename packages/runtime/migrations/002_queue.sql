-- The durable job queue (RUNTIME §4, ANY-34 R8): one `jobs` table next to the
-- event log. Claims run under FOR UPDATE SKIP LOCKED; the lease lives in
-- `lease_until` (min(now + heartbeat, claim + max run), maintained by the
-- queue); per-stream serial rules and the per-workspace cap are filters inside
-- the claim's snapshot; retries requeue through `run_at`.

create table if not exists jobs (
  id text primary key,
  type text not null,
  key text not null,
  stream_id text,
  workspace_id text not null,
  -- Injected-clock instant the job becomes claimable; retries push it out.
  run_at bigint not null default 0,
  payload jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed', 'dead')),
  -- Runs started, including the current lease; the lease attempt is this value.
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  worker_id text,
  -- Set at the claim; anchors the max-run cap across heartbeats.
  run_started_at bigint,
  lease_until bigint,
  -- Insertion order: equal `run_at` claims in enqueue order.
  seq bigint generated always as identity
);

-- The claim's scan: live rows of the requested types, due ones first.
create index if not exists jobs_claim_idx
  on jobs (type, run_at, seq)
  where status in ('pending', 'leased');

-- At most one live (pending | leased) job per key; a completed or dead key
-- re-enqueues as a new row. Enforce the dedupe database-side, inside whatever
-- transaction the caller brought.
create unique index if not exists jobs_live_key
  on jobs (key)
  where status in ('pending', 'leased');
