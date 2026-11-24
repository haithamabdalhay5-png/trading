begin;

create table if not exists public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status text not null check (status in ('QUEUED','RUNNING','COMPLETED','FAILED','REJECTED','CANCELLED')),
  depth text not null check (depth in ('PROTECTIVE','STANDARD','DEEP')),
  snapshot_hash text not null,
  snapshot_packet jsonb not null,
  snapshot_timestamp timestamptz not null,
  snapshot_received_at timestamptz not null,
  snapshot_source text not null default 'mt5' check (snapshot_source = 'mt5'),
  snapshot_age_seconds integer not null,
  final_decision text check (final_decision in ('BUY','SELL','WAIT','NO_TRADE')),
  final_report jsonb,
  current_stage text,
  provider text,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(12,8) not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_runs_hash_chk check (length(snapshot_hash) = 64),
  constraint analysis_runs_snapshot_age_chk check (snapshot_age_seconds between 0 and 45)
);

create unique index if not exists analysis_runs_idempotency_uq
  on public.analysis_runs(idempotency_key)
  where idempotency_key is not null;
create index if not exists analysis_runs_created_at_idx on public.analysis_runs(created_at desc);
create index if not exists analysis_runs_status_idx on public.analysis_runs(status, updated_at desc);
create index if not exists analysis_runs_user_created_idx on public.analysis_runs(user_id, created_at desc);

create table if not exists public.analysis_stage_results (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analysis_runs(id) on delete cascade,
  snapshot_hash text not null,
  stage text not null,
  status text not null check (status in ('QUEUED','RUNNING','COMPLETED','FAILED','SKIPPED')),
  result jsonb,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  provider_error text,
  attempt_count integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_stage_results_snapshot_hash_chk check (length(snapshot_hash) = 64),
  constraint analysis_stage_results_unique unique (analysis_id, snapshot_hash, stage)
);

create index if not exists analysis_stage_results_pending_idx
  on public.analysis_stage_results(status, lease_until, created_at);

create table if not exists public.qstash_outbox (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analysis_runs(id) on delete cascade,
  snapshot_hash text not null,
  stage text not null,
  destination text not null,
  payload jsonb not null,
  deduplication_id text not null,
  published boolean not null default false,
  published_at timestamptz,
  publish_error text,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qstash_outbox_unique unique (analysis_id, snapshot_hash, stage),
  constraint qstash_outbox_dedup_unique unique (deduplication_id)
);

create index if not exists qstash_outbox_pending_idx
  on public.qstash_outbox(published, created_at);

create table if not exists public.miras_daily_budget (
  day_key date primary key,
  reserved_messages integer not null default 0,
  consumed_messages integer not null default 0,
  standard_analyses integer not null default 0,
  deep_analyses integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint miras_daily_budget_reserved_chk check (reserved_messages >= 0 and reserved_messages <= 800),
  constraint miras_daily_budget_consumed_chk check (consumed_messages >= 0)
);

create table if not exists public.telegram_delivery_records (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analysis_runs(id) on delete restrict,
  status text not null check (status in ('QUEUED','SENT','FAILED')),
  idempotency_key text not null,
  telegram_message_id bigint,
  error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_delivery_unique unique (analysis_id),
  constraint telegram_delivery_idempotency_unique unique (idempotency_key)
);

create or replace function public.reserve_miras_analysis_budget(
  p_day date,
  p_depth text,
  p_reserved integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_reserved integer;
  current_standard integer;
  current_deep integer;
begin
  if p_depth not in ('STANDARD','DEEP') or p_reserved <= 0 then
    return false;
  end;

  insert into public.miras_daily_budget(day_key, reserved_messages)
  values (p_day, 0)
  on conflict (day_key) do, standard_analyses, deep_analyses
    into current_reserved, current_standard, current_deep

  select reserved_messages into current_reserved
  from public.miras_daily_budget
  where day_key = p_day
  for update;

  if coalesce(current_reserved, 0) + p_reserved > 800 then
    return false;
  if p_depth = 'STANDARD' and coalesce(current_standard, 0) >= 20 then
    return false;
  end;
  if p_depth = 'DEEP' and coalesce(current_deep, 0) >= 10 then
    return false;
  end;
  end;

  update public.miras_daily_budget
  set
    reserved_messages = reserved_messages + p_reserved,
    standard_analyses = standard_analyses + case when p_depth = 'STANDARD' then 1 else 0 end,
    deep_analyses = deep_analyses + case when p_depth = 'DEEP' then 1 else 0 end,
    updated_at = now()
  where day_key = p_day;

  return true;
end;
$$;

create or replace function public.claim_analysis_stage(
  p_analysis_id uuid,
  p_snapshot_hash text,
  p_stage text,
  p_owner text,
  p_lease_until timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  stage_row public.analysis_stage_results%rowtype;
begin
  select * into stage_row
  from public.analysis_stage_results
  where analysis_id = p_analysis_id
    and snapshot_hash = p_snapshot_hash
    and stage = p_stage
  for update;

  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end;
  if stage_row.status = 'COMPLETED' then
    return jsonb_build_object('status', 'COMPLETED', 'result', stage_row.result);
  end;
  if stage_row.status = 'RUNNING'
     and stage_row.lease_until is not null
     and stage_row.lease_until > now()
     and stage_row.lease_owner is distinct from p_owner then
    return jsonb_build_object('status', 'LEASED');
  end;

  update public.analysis_stage_results
  set status = 'RUNNING',
      lease_owner = p_owner,
      lease_until = p_lease_until,
      attempt_count = attempt_count + 1,
      started_at = now(),
      updated_at = now()
  where id = stage_row.id;

  return jsonb_build_object('status', 'CLAIMED', 'attempt_count', stage_row.attempt_count + 1);
end;
$$;

revoke all on function public.claim_analysis_stage from public, anon, authenticated;
grant execute on function public.claim_analysis_stage to service_role;

create or replace function public.refund_miras_analysis_budget(
  p_day date,
  p_depth text,
  p_refund integer,
  p_consumed integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.miras_daily_budget
  set reserved_messages = greatest(0, reserved_messages - p_refund),
      consumed_messages = consumed_messages + greatest(0, p_consumed),
      standard_analyses = case when p_depth = 'STANDARD' then greatest(0, standard_analyses - 1) else standard_analyses end,
      deep_analyses = case when p_depth = 'DEEP' then greatest(0, deep_analyses - 1) else deep_analyses end,
      updated_at = now()
  where day_key = p_day;
end;
$$;

revoke all on function public.refund_miras_analysis_budget from public, anon, authenticated;
grant execute on function public.refund_miras_analysis_budget to service_role;

alter table public.analysis_runs enable row level security;
alter table public.analysis_stage_results enable row level security;
alter table public.qstash_outbox enable row level security;
alter table public.miras_daily_budget enable row level security;
alter table public.telegram_delivery_records enable row level security;

revoke all on public.analysis_runs, public.analysis_stage_results, public.qstash_outbox, public.miras_daily_budget, public.telegram_delivery_records
  from anon, authenticated;
revoke all on function public.reserve_miras_analysis_budget from public, anon, authenticated;

grant all on public.analysis_runs, public.analysis_stage_results, public.qstash_outbox, public.miras_daily_budget, public.telegram_delivery_records to service_role;
grant execute on function public.reserve_miras_analysis_budget to service_role;

create policy analysis_runs_owner_select
  on public.analysis_runs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy telegram_delivery_owner_select
  on public.telegram_delivery_records
  for select
  to authenticated
  using (
    exists (
      select 1 from public.analysis_runs r
      where r.id = telegram_delivery_records.analysis_id
        and r.user_id = auth.uid()
    )
  );

commit;
