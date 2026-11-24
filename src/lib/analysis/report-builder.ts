import type { FinalDecision, MarketContext } from "@/lib/analysis/types";

export function buildReport(input: {
  context: MarketContext;
  judge: Record<string, unknown>;
  specialists: Record<string, unknown>;
  stages: Record<string, unknown>;
}) {
  const judge = input.judge;
  const decision: FinalDecision = judge.decision === "BUY" || judge.decision === "SELL" || judge.decision === "WAIT" || judge.decision === "NO_TRADE"
    ? judge.decision
    : "NO_TRADE";

  const bid = input.context.bid;
  const ask = input.context.ask;
  const atr = input.context.atr.M5;
  const lowAtr = Math.max(input.context.tick_size, atr * 0.05);

  let entryZone: { low: number; high: number } | null = null;
  let stopLoss: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;

  if (decision === "BUY") {
    entryZone = { low: ask, high: ask + lowAtr };
    stopLoss = ask - atr * 0.75;
    tp1 = ask + atr * 0.75;
    tp2 = ask + atr * 1.5;
    tp3 = ask + atr * 2.25;
  } else if (decision === "SELL") {
    entryZone = { low: bid - lowAtr, high: bid };
    stopLoss = bid + atr * 0.75;
    tp1 = bid - atr * 0.75;
    tp2 = bid - atr * 1.5;
    tp3 = bid - atr * 2.25;
  }

  const round = (value: number | null) => value === null ? null : Number(value.toFixed(input.context.digits));
  entryZone = entryZone ? { low: round(entryZone.low)!, high: round(entryZone.high)! } : null;
  stopLoss = round(stopLoss);
  tp1 = round(tp1);
  tp2 = round(tp2);
  tp3 = round(tp3);

  const risk = entryZone && stopLoss
    ? decision === "BUY"
      ? entryZone.low - stopLoss
      : stopLoss - entryZone.high
    : null;
  const reward = entryZone && tp1
    ? decision === "BUY"
      ? tp1 - entryZone.high
      : entryZone.low - tp1
    : null;

  return {
    decision,
    market_bias: input.specialists,
    current_price: { bid, ask },
    snapshot_timestamp: input.context.snapshot_timestamp,
    snapshot_hash: input.context.snapshot_hash,
    snapshot_age_seconds: input.context.snapshot_age_seconds,
    data_source: "mt5",
    market_regime: input.context.regime,
    market_session: input.context.market_session,
    evidence_strength: judge.evidence_strength ?? "LOW",
    confidence: judge.confidence ?? "LOW",
    main_reasoning: judge.main_reasoning ?? [],
    risks: judge.risks ?? [],
    invalidation: judge.invalidation ?? [],
    alternative_scenario: judge.alternative_scenario ?? "NO_TRADE",
    specialist_reports: input.specialists,
    bull_bear: input.stages,
    entry_zone: entryZone,
    stop_loss: stopLoss,
    tp1,
    tp2,
    tp3,
    risk_reward: risk && reward && risk > 0 ? Number((reward / risk).toFixed(2)) : null,
    risk_vetoes: [] as string[],
    setup_expiration_seconds: judge.setup_expiration_seconds ?? 900,
  };
}
