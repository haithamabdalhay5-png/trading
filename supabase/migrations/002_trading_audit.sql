-- supabase/migrations/002_trading_audit.sql
-- مِرصد: جداول التدقيق (قرارات القاضي، تقييمات الوكلاء، أخطاء النظام)
-- لم تُنفَّذ بعد: شغّلها يدويًا من Supabase SQL Editor. الوصول عبر service_role من الخادم حصرًا.

begin;

-- =====================================================================
-- 1) judge_decisions
-- =====================================================================
create table if not exists public.judge_decisions (
    id                uuid primary key default gen_random_uuid(),
    decided_at        timestamptz not null default now(),  -- UTC (timestamptz يخزن UTC داخليًا)
    symbol            text not null,
    regime            text not null,
    hurst             numeric(5,4),
    verdict           text not null,
    s_total           numeric(8,4),
    sigma_s           numeric(8,4),
    veto              boolean not null default false,
    veto_reasons      text[] not null default '{}',
    entry_zone_low    numeric(14,5),
    entry_zone_high   numeric(14,5),
    tp1               numeric(14,5),
    tp2               numeric(14,5),
    tp3               numeric(14,5),
    stop_loss         numeric(14,5),
    lot_size          numeric(10,2),
    evaluation_status text not null default 'PENDING',
    created_at        timestamptz not null default now(),

    constraint judge_decisions_symbol_chk
        check (symbol in ('XAUUSD', 'XAGUSD', 'XPTUSD')),
    constraint judge_decisions_regime_chk
        check (regime in ('TRENDING', 'MEAN_REVERTING', 'NOISE')),
    constraint judge_decisions_hurst_chk
        check (hurst is null or (hurst >= 0 and hurst <= 1)),
    constraint judge_decisions_verdict_chk
        check (verdict in ('BUY', 'SELL', 'NEUTRAL')),
    constraint judge_decisions_sigma_s_chk
        check (sigma_s is null or sigma_s >= 0),
    constraint judge_decisions_eval_status_chk
        check (evaluation_status in ('PENDING', 'HIT_TP1', 'HIT_TP2', 'HIT_TP3', 'STOPPED_OUT')),
    -- Veto يستلزم سببًا واحدًا على الأقل، والقرار المرفوض لا يكون BUY/SELL
    constraint judge_decisions_veto_reasons_chk
        check (not veto or cardinality(veto_reasons) > 0),
    constraint judge_decisions_veto_neutral_chk
        check (not veto or verdict = 'NEUTRAL'),
    -- القيم السعرية والحجم موجبة
    constraint judge_decisions_prices_positive_chk
        check (
            coalesce(entry_zone_low, 1) > 0 and coalesce(entry_zone_high, 1) > 0
            and coalesce(tp1, 1) > 0 and coalesce(tp2, 1) > 0 and coalesce(tp3, 1) > 0
            and coalesce(stop_loss, 1) > 0 and coalesce(lot_size, 1) > 0
        ),
    constraint judge_decisions_entry_zone_chk
        check (entry_zone_low is null or entry_zone_high is null or entry_zone_low <= entry_zone_high),
    -- اتساق الاتجاه: BUY => SL تحت الدخول وTP فوقه، SELL => العكس
    constraint judge_decisions_buy_levels_chk
        check (
            verdict <> 'BUY'
            or entry_zone_low is null or entry_zone_high is null
            or (
                (stop_loss is null or stop_loss < entry_zone_low)
                and (tp1 is null or tp1 > entry_zone_high)
                and (tp2 is null or tp1 is null or tp2 >= tp1)
                and (tp3 is null or tp2 is null or tp3 >= tp2)
            )
        ),
    constraint judge_decisions_sell_levels_chk
        check (
            verdict <> 'SELL'
            or entry_zone_low is null or entry_zone_high is null
            or (
                (stop_loss is null or stop_loss > entry_zone_high)
                and (tp1 is null or tp1 < entry_zone_low)
                and (tp2 is null or tp1 is null or tp2 <= tp1)
                and (tp3 is null or tp2 is null or tp3 <= tp2)
            )
        ),
    -- قرار فعّال (BUY/SELL غير مرفوض) يجب أن يحمل الدخول والوقف وTP1 والحجم
    constraint judge_decisions_actionable_complete_chk
        check (
            verdict = 'NEUTRAL' or veto
            or (
                entry_zone_low is not null and entry_zone_high is not null
                and stop_loss is not null and tp1 is not null and lot_size is not null
            )
        )
);

create index if not exists judge_decisions_decided_at_idx
    on public.judge_decisions (decided_at desc);
create index if not exists judge_decisions_symbol_decided_at_idx
    on public.judge_decisions (symbol, decided_at desc);
create index if not exists judge_decisions_pending_idx
    on public.judge_decisions (symbol, decided_at)
    where evaluation_status = 'PENDING';

-- =====================================================================
-- 2) agent_evaluations
-- =====================================================================
create table if not exists public.agent_evaluations (
    id               uuid primary key default gen_random_uuid(),
    decision_id      uuid not null
        references public.judge_decisions (id) on delete restrict,
    agent_name       text not null,
    score_s          numeric(8,4) not null,   -- S_i
    confidence_c     numeric(5,4) not null,   -- C_i
    effective_weight numeric(8,6) not null,   -- W_i
    reason_summary   text not null,
    accuracy_correct boolean,                 -- null = لم يُقيَّم بعد؛ true = أصاب الاتجاه؛ false = أخطأ
    created_at       timestamptz not null default now(),

    constraint agent_evaluations_agent_name_chk
        check (agent_name in (
            'structure_liquidity', 'technical', 'fundamental',
            'correlation_quant_regime', 'sentiment', 'risk_prosecutor'
        )),
    constraint agent_evaluations_confidence_chk
        check (confidence_c >= 0 and confidence_c <= 1),
    constraint agent_evaluations_weight_chk
        check (effective_weight >= 0),
    constraint agent_evaluations_reason_chk
        check (length(btrim(reason_summary)) > 0),
    constraint agent_evaluations_decision_agent_uq
        unique (decision_id, agent_name)
);

-- unique (decision_id, agent_name) يغطي البحث حسب decision_id (العمود الأول)
create index if not exists agent_evaluations_agent_created_idx
    on public.agent_evaluations (agent_name, created_at desc);

-- =====================================================================
-- 3) system_errors
-- =====================================================================
create table if not exists public.system_errors (
    id                uuid primary key default gen_random_uuid(),
    occurred_at       timestamptz not null default now(),  -- UTC
    error_code        text not null,
    source            text not null,
    severity          text not null,
    technical_message text not null,
    action_taken      text not null,

    constraint system_errors_source_chk
        check (source in ('MT5', 'Redis', 'Gemini', 'Supabase', 'Telegram')),
    constraint system_errors_severity_chk
        check (severity in ('CRITICAL', 'WARNING', 'VETO')),
    constraint system_errors_code_chk
        check (length(btrim(error_code)) > 0),
    constraint system_errors_action_chk
        check (length(btrim(action_taken)) > 0)
);

create index if not exists system_errors_occurred_at_idx
    on public.system_errors (occurred_at desc);
create index if not exists system_errors_severity_occurred_at_idx
    on public.system_errors (severity, occurred_at desc);
create index if not exists system_errors_source_occurred_at_idx
    on public.system_errors (source, occurred_at desc);

-- =====================================================================
-- RLS: مفعّل بلا أي سياسة => anon/authenticated محجوبان بالكامل.
-- service_role يتجاوز RLS بطبيعته (BYPASSRLS).
-- =====================================================================
alter table public.judge_decisions   enable row level security;
alter table public.agent_evaluations enable row level security;
alter table public.system_errors     enable row level security;

-- طبقة دفاع إضافية: سحب صلاحيات الجداول من الأدوار العامة
revoke all on table public.judge_decisions   from anon, authenticated;
revoke all on table public.agent_evaluations from anon, authenticated;
revoke all on table public.system_errors     from anon, authenticated;

grant select, insert, update on public.judge_decisions   to service_role;
grant select, insert, update on public.agent_evaluations to service_role;
grant select, insert         on public.system_errors     to service_role;

commit;