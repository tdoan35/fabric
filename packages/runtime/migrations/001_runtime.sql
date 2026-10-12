-- Runtime core tables (RUNTIME §2): append-only per-stream event logs.

create table if not exists streams (
  id text primary key,
  workspace_id text not null,
  head integer not null default 0 check (head >= 0)
);

create table if not exists events (
  id text primary key,
  workspace_id text not null,
  stream_id text not null,
  seq integer not null check (seq >= 1),
  type text not null,
  class text not null,
  v integer not null check (v >= 1),
  actor text not null,
  causation text,
  ts timestamptz not null default now(),
  payload jsonb not null
);

create unique index if not exists events_stream_seq_key
  on events (stream_id, seq);

-- A retried job's second append is a no-op: at most one fact per causation, per stream.
create unique index if not exists events_stream_causation_fact_key
  on events (stream_id, causation)
  where causation is not null and class = 'fact';
