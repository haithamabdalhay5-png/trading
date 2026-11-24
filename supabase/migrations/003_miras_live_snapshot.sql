begin;

create table if not exists public.xau_latest_snapshot (
  id smallint primary key default 1 check (id = 1),
  packet jsonb not null,
  packet_hash text not null,
  source text not null check (source = 'mt5'),
  received_at timestamptz not null,
  source_timestamp timestamptz not null,
  bid numeric(14,5) not null,
  ask numeric(14,5) not null,
  spread_points integer not null,
  digits integer not null,
  tick_size numeric(14,8) not null,
  symbol text not null,
  market_session text,
  market_regime text,
  stale boolean not null default false,
  mt5_live boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint xau_latest_snapshot_hash_chk check (length(packet_hash) = 64)
);

create index if not exists xau_latest_snapshot_updated_at_idx
  on public.xau_latest_snapshot (updated_at desc);

create table if not exists public.market_monitoring_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  symbol text not null default 'XAUUSD',
  message text not null,
  severity text not null check (severity in ('INFO', 'WARNING', 'CRITICAL')),
  packet_hash text,
  occurred_at timestamptz not null default now()
);

create index if not exists market_monitoring_events_occurred_at_idx
  on public.market_monitoring_events (occurred_at desc);

create or replace function public.replace_xau_latest_snapshot(
  p_packet jsonb,
  p_packet_hash text,
  p_received_at timestamptz,
  p_source_timestamp timestamptz,
  p_bid numeric,
  p_ask numeric,
  p_spread_points integer,
  p_digits integer,
  p_tick_size numeric,
  p_symbol text,
  p_market_session text,
  p_market_regime text,
  p_stale boolean,
  p_mt5_live boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_packet jsonb;
begin
  select packet into previous_packet
  from public.xau_latest_snapshot
  where id = 1
  for update;

  insert into public.xau_latest_snapshot (
    id, packet, packet_hash, source, received_at, source_timestamp,
    bid, ask, spread_points, digits, tick_size, symbol,
    market_session, market_regime, stale, mt5_live, updated_at
  )
  values (
    1, p_packet, p_packet_hash, 'mt5', p_received_at, p_source_timestamp,
    p_bid, p_ask, p_spread_points, p_digits, p_tick_size, p_symbol,
    p_market_session, p_market_regime, p_stale, p_mt5_live, now()
  )
  on conflict (id) do update set
    packet = excluded.packet,
    packet_hash = excluded.packet_hash,
    source = excluded.source,
    received_at = excluded.received_at,
    source_timestamp = excluded.source_timestamp,
    bid = excluded.bid,
    ask = excluded.ask,
    spread_points = excluded.spread_points,
    digits = excluded.digits,
    tick_size = excluded.tick_size,
    symbol = excluded.symbol,
    market_session = excluded.market_session,
    market_regime = excluded.market_regime,
    stale = excluded.stale,
    mt5_live = excluded.mt5_live,
    updated_at = excluded.updated_at;

  return jsonb_build_object('previous_packet', previous_packet);
end;
$$;

revoke all on function public.replace_xau_latest_snapshot from public, anon, authenticated;
grant execute on function public.replace_xau_latest_snapshot to service_role;

alter table public.xau_latest_snapshot enable row level security;
alter table public.market_monitoring_events enable row level security;

revoke all on public.xau_latest_snapshot, public.market_monitoring_events from anon, authenticated;
grant select, insert, update on public.xau_latest_snapshot to service_role;
grant select, insert, update on public.market_monitoring_events to service_role;

commit;
