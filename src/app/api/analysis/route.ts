import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { rejectInvalidOrigin, unauthorized } from "@/lib/dashboard-auth";
import { createSupabaseSessionClient } from "@/lib/supabase-server";
import { hashMarketPacket, readLatestXauSnapshot, createSupabaseServerClient } from "@/lib/supabase-market-store";
import { findXauCommodity } from "@/lib/xau-symbol";
import { reserveDailyBudget, addOutboxStage, publishOutboxStage } from "@/lib/analysis/qstash-engine";
import { selectAdaptiveDepth } from "@/lib/analysis/adaptive-depth";
import type { AnalysisDepth, MarketContext } from "@/lib/analysis/types";

function buildContextFromLive(live: Awaited<ReturnType<typeof readLatestXauSnapshot>>) {
  if (!live) return null;
  const packet = live.packet;
  const commodity = findXauCommodity(packet.commodities);
  if (!commodity) return null;

  const age = Math.max(0, Math.floor((Date.now() - Date.parse(packet.utc_timestamp)) / 1_000));
  const context: MarketContext = {
    snapshot_hash: live.packet_hash,
    snapshot_timestamp: packet.utc_timestamp,
    snapshot_age_seconds: age,
    source: "mt5",
    symbol: live.symbol,
    bid: live.bid,
    ask: live.ask,
    digits: live.digits,
    tick_size: live.tick_size,
    spread_points: live.spread_points,
    atr: commodity.quant_regime.atr_14,
    market_session: commodity.meta.market_session,
    in_killzone: commodity.meta.in_killzone,
    regime: commodity.quant_regime.detected_regime,
    indicators: {},
    structure: commodity.smc_structure,
    liquidity: commodity.liquidity_pools,
    volume: commodity.microstructure_volume,
    intermarket: packet.intermarket,
    candles: commodity.candles_data,
  };
  return context;
}

export async function POST(request: Request) {
  let reservedDepth: "STANDARD" | "DEEP" | null = null;
  let reservedDay: string | null = null;
  if (rejectInvalidOrigin(request)) return unauthorized();
  const sessionClient = await createSupabaseSessionClient();
  if (!sessionClient) return unauthorized();
  const { data: sessionData, error: sessionError } = await sessionClient.auth.getUser();
  if (sessionError || !sessionData.user) return unauthorized();

  const client = createSupabaseServerClient();
  if (!client) return NextResponse.json({ error: "SUPABASE_NOT_CONFIGURED" }, { status: 503 });

  try {
    const live = await readLatestXauSnapshot();
    if (!live) return NextResponse.json({ error: "NO_LIVE_SNAPSHOT" }, { status: 409 });

    const context = buildContextFromLive(live);
    if (!context) return NextResponse.json({ error: "XAUUSD_NOT_FOUND" }, { status: 422 });
    if (context.snapshot_age_seconds > 45) return NextResponse.json({ error: "STALE_SNAPSHOT", snapshot_age_seconds: context.snapshot_age_seconds }, { status: 409 });

    const depthSelection = selectAdaptiveDepth(context, { spreadLimit: 35 });
    const depth: AnalysisDepth = depthSelection.depth;
    if (depth === "PROTECTIVE") {
      return NextResponse.json({
        status: "REJECTED",
        depth,
        reasons: depthSelection.reasons,
        final_decision: "NO_TRADE",
      }, { status: 200 });
    }

    const budgetDepth = depth === "DEEP" ? "DEEP" : "STANDARD";
    const reservation = await reserveDailyBudget({ depth: budgetDepth });
    reservedDepth = budgetDepth;
    reservedDay = reservation.day;

    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
    const analysisId = randomUUID();
    const packetHash = hashMarketPacket(live.packet);

    const { error: insertError } = await client.from("analysis_runs").insert({
      id: analysisId,
      user_id: sessionData.user.id,
      status: "QUEUED",
      depth,
      snapshot_hash: packetHash,
      snapshot_packet: live.packet,
      snapshot_timestamp: live.source_timestamp,
      snapshot_received_at: live.received_at,
      snapshot_source: "mt5",
      snapshot_age_seconds: context.snapshot_age_seconds,
      current_stage: "SNAPSHOT_VALIDATION",
      idempotency_key: idempotencyKey,
      started_at: new Date().toISOString(),
    });
    if (insertError) {
      if (insertError.code === "23505") {
        return NextResponse.json({ error: "DUPLICATE_ANALYSIS_REQUEST" }, { status: 409 });
      }
      throw insertError;
    }

    const stageNames = depth === "DEEP"
      ? ["SNAPSHOT_VALIDATION", "STRUCTURE_SPECIALIST", "VOLUME_SPECIALIST", "LIQUIDITY_SPECIALIST", "MACRO_SPECIALIST", "BULL_ANALYST", "BEAR_ANALYST", "DEBATE", "FINAL_JUDGE", "RISK_VALIDATOR", "REPORT_COMPLETION"]
      : ["SNAPSHOT_VALIDATION", "STRUCTURE_SPECIALIST", "VOLUME_SPECIALIST", "LIQUIDITY_SPECIALIST", "MACRO_SPECIALIST", "FINAL_JUDGE", "RISK_VALIDATOR", "REPORT_COMPLETION"];

    for (const stage of stageNames) {
      await client.from("analysis_stage_results").insert({
        analysis_id: analysisId,
        snapshot_hash: packetHash,
        stage,
        status: stage === "SNAPSHOT_VALIDATION" ? "QUEUED" : "QUEUED",
      });
    }

    const aiStages = depth === "DEEP"
      ? ["STRUCTURE_SPECIALIST", "VOLUME_SPECIALIST", "LIQUIDITY_SPECIALIST", "MACRO_SPECIALIST", "BULL_ANALYST", "BEAR_ANALYST", "DEBATE", "FINAL_JUDGE"]
      : ["STRUCTURE_SPECIALIST", "VOLUME_SPECIALIST", "LIQUIDITY_SPECIALIST", "MACRO_SPECIALIST", "FINAL_JUDGE"];

    await client.from("analysis_stage_results").update({ status: "COMPLETED", result: { valid: true }, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("analysis_id", analysisId).eq("stage", "SNAPSHOT_VALIDATION");

    for (const stage of aiStages) {
      await addOutboxStage({
        analysisId,
        snapshotHash: packetHash,
        stage: stage as Parameters<typeof addOutboxStage>[0]["stage"],
        payload: { analysisId, snapshotHash: packetHash, stage },
      });
    }

    await publishOutboxStage({ analysisId, snapshotHash: packetHash, stage: aiStages[0] as Parameters<typeof publishOutboxStage>[0]["stage"] });

    return NextResponse.json({ analysisId, status: "QUEUED", depth, snapshot_hash: packetHash, snapshot_age_seconds: context.snapshot_age_seconds });
  } catch (error) {
    if (reservedDepth && reservedDay) {
      await client?.rpc("refund_miras_analysis_budget", {
        p_day: reservedDay,
        p_depth: reservedDepth,
        p_refund: reservedDepth === "DEEP" ? 16 : 10,
        p_consumed: 0,
      });
    }
    if (error instanceof Error && error.message === "DAILY_QSTASH_BUDGET_EXHAUSTED") {
      return NextResponse.json({ error: "DAILY_QSTASH_BUDGET_EXHAUSTED", message: "Daily QStash reserved budget is exhausted." }, { status: 429 });
    }
    return NextResponse.json({ error: "ANALYSIS_START_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
