create table if not exists public.market_snapshots (
  id bigint generated always as identity primary key,
  received_at timestamptz not null,
  source_timestamp timestamptz not null,
  schema_version text not null,
  symbol_count integer not null check (symbol_count >= 1),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists market_snapshots_received_at_idx
  on public.market_snapshots (received_at desc);

alter table public.market_snapshots enable row level security;

-- No anon/authenticated policies by design. Writes are made only by the
-- server-side service-role credential; never expose that key to MT5/browser.
