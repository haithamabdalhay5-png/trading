import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { createSupabaseServerClient } from "@/lib/supabase-market-store";
import { claimStage, completeStage, failStage, type StageName } from "@/lib/analysis/stage-engine";
import { generateStructuredGeminiJson } from "@/lib/analysis/gemini-client";
import { specialistSchema, finalJudgeSchema, bullBearSchema, debateSchema } from "@/lib/analysis/schemas";
import { buildXauMarketContext } from "@/lib/analysis/market-context";
import { findXauCommodity } from "@/lib/xau-symbol";
import type { MarketPacket } from "@/lib/market-schema";
import { toJSONSchema } from "zod/v4";
import { buildReport } from "@/lib/analysis/report-builder";
import { validateEntryProposal } from "@/lib/analysis/entry-validator";
import { spreadLimitFor } from "@/lib/risk-config";

const STANDARD_SEQUENCE: Record<string, StageName | null> = {
  SNAPSHOT_VALIDATION: "STRUCTURE_SPECIALIST",
  STRUCTURE_SPECIALIST: "VOLUME_SPECIALIST",
  VOLUME_SPECIALIST: "LIQUIDITY_SPECIALIST",
  LIQUIDITY_SPECIALIST: "MACRO_SPECIALIST",
  MACRO_SPECIALIST: "FINAL_JUDGE",
  FINAL_JUDGE: null,
  REPORT_COMPLETION: null,
};

const DEEP_SEQUENCE: Record<string, StageName | null> = {
  SNAPSHOT_VALIDATION: "STRUCTURE_SPECIALIST",
  STRUCTURE_SPECIALIST: "VOLUME_SPECIALIST",
  VOLUME_SPECIALIST: "LIQUIDITY_SPECIALIST",
  LIQUIDITY_SPECIALIST: "MACRO_SPECIALIST",
  MACRO_SPECIALIST: "BULL_ANALYST",
  BULL_ANALYST: "BEAR_ANALYST",
  BEAR_ANALYST: "DEBATE",
  DEBATE: "FINAL_JUDGE",
  FINAL_JUDGE: null,
  REPORT_COMPLETION: null,
};

export function getNextStage(stage: StageName, depth: string): StageName | null {
  return (depth === "DEEP" ? DEEP_SEQUENCE : STANDARD_SEQUENCE)[stage] ?? null;
}

const specialistPrompts: Partial<Record<StageName, string>> = {
  STRUCTURE_SPECIALIST: "Analyze XAUUSD market structure: HH/HL/LH/LL, BOS, CHoCH, H1/H4/M15 alignment, supply/demand, FVG, and order blocks. Never invent data.",
  VOLUME_SPECIALIST: "Analyze XAUUSD volume profile: POC, VAH, VAL, VWAP, RVOL and synthetic CVD limitations. Never describe synthetic CVD as exchange order flow.",
  LIQUIDITY_SPECIALIST: "Analyze XAUUSD liquidity pools, sweeps, stops, inducement, FVG, and order blocks. Distinguish confirmed from possible scenarios.",
  MACRO_SPECIALIST: "Analyze available DXY, XAU/XAG relationship, market session and killzone. If news data is unavailable, return NEWS_DATA_UNAVAILABLE. Never invent economic events.",
  BULL_ANALYST: "Build the strongest evidence-based bullish XAUUSD scenario only. Consider BUY scenarios only.",
  BEAR_ANALYST: "Build the strongest evidence-based bearish XAUUSD scenario only. Consider SELL scenarios only.",
  DEBATE: "Challenge Bull and Bear assumptions using only supplied evidence. Identify unsupported claims and contradictions.",
};

async function completeFinalReport(input: {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  analysisId: string;
  snapshotHash: string;
  leaseOwner: string;
  run: { snapshot_packet: MarketPacket; snapshot_timestamp: string };
}) {
  if (!input.supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data: runStages } = await input.supabase
    .from("analysis_stage_results")
    .select("stage,status,result")
    .eq("analysis_id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash);

  const packet = input.run.snapshot_packet;
  const commodity = findXauCommodity(packet.commodities);
  if (!commodity) throw new Error("XAUUSD_NOT_FOUND");

  const context = buildXauMarketContext({
    packet,
    commodity,
    snapshotHash: input.snapshotHash,
    receivedAt: input.run.snapshot_timestamp,
    sourceTimestamp: input.run.snapshot_timestamp,
  });

  const judge = runStages?.find((stage) => stage.stage === "FINAL_JUDGE")?.result as Record<string, unknown> | undefined;
  if (!judge) throw new Error("FINAL_JUDGE_RESULT_MISSING");

  const specialists = Object.fromEntries((runStages ?? [])
    .filter((stage) => ["STRUCTURE_SPECIALIST", "VOLUME_SPECIALIST", "LIQUIDITY_SPECIALIST", "MACRO_SPECIALIST"].includes(stage.stage))
    .map((stage) => [stage.stage, stage.result]));
  const bullBear = Object.fromEntries((runStages ?? [])
    .filter((stage) => ["BULL_ANALYST", "BEAR_ANALYST", "DEBATE"].includes(stage.stage))
    .map((stage) => [stage.stage, stage.result]));

  const report = buildReport({ context, judge, specialists, stages: bullBear });
  const vetoes: string[] = [];
  if (commodity.meta.spread_points > spreadLimitFor(commodity.meta.symbol)) vetoes.push("XAU_SPREAD_VETO");
  if (commodity.quant_regime.atr_14.M5 <= 0) vetoes.push("MISSING_ATR_M5");
  if ((runStages ?? []).some((stage) => stage.status === "FAILED")) vetoes.push("FAILED_SPECIALIST_STAGE");

  if (report.decision === "BUY" || report.decision === "SELL") {
    const validation = validateEntryProposal({
      proposal: {
        verdict: report.decision,
        entry_low: report.entry_zone?.low ?? undefined,
        entry_high: report.entry_zone?.high ?? undefined,
        stop_loss: report.stop_loss ?? undefined,
        tp1: report.tp1 ?? undefined,
        tp2: report.tp2 ?? undefined,
        tp3: report.tp3 ?? undefined,
      },
      bid: context.bid,
      ask: context.ask,
      spreadPoints: context.spread_points,
      spreadLimit: spreadLimitFor(context.symbol),
      atrM5: context.atr.M5,
      digits: context.digits,
      tickSize: context.tick_size,
    });
    if (!validation.valid) vetoes.push(...validation.reasons);
  }

  if (vetoes.length > 0) {
    report.decision = "NO_TRADE";
    report.entry_zone = null;
    report.stop_loss = null;
    report.tp1 = null;
    report.tp2 = null;
    report.tp3 = null;
  }
  report.risk_vetoes = vetoes;

  const { error: updateError } = await input.supabase
    .from("analysis_runs")
    .update({
      status: "COMPLETED",
      final_decision: report.decision,
      final_report: report,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash);
  if (updateError) throw new Error(`FINAL_REPORT_SAVE_FAILED:${updateError.code}`);

  await input.supabase
    .from("analysis_stage_results")
    .update({ status: "COMPLETED", result: { vetoes }, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("analysis_id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash)
    .eq("stage", "RISK_VALIDATOR");
  await input.supabase
    .from("analysis_stage_results")
    .update({ status: "COMPLETED", result: { completed: true, final_decision: report.decision }, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("analysis_id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash)
    .eq("stage", "REPORT_COMPLETION");
}

async function verifyQstash(request: Request, rawBody: string) {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current || !next) throw new Error("QSTASH_SIGNING_KEYS_NOT_CONFIGURED");
  const receiver = new Receiver({ currentSigningKey: current, nextSigningKey: next });
  const signature = request.headers.get("upstash-signature") ?? "";
  const url = `${process.env.APP_URL?.replace(/\/+$/, "")}${new URL(request.url).pathname}`;
  return receiver.verify({ body: rawBody, signature, url });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rawBody = await request.text();
  try {
    if (!(await verifyQstash(request, rawBody))) {
      return NextResponse.json({ error: "INVALID_QSTASH_SIGNATURE" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "INVALID_QSTASH_SIGNATURE" }, { status: 401 });
  }

  const { id: analysisId } = await context.params;
  let payload: { snapshotHash: string; stage: StageName }; 
  try {
    payload = JSON.parse(rawBody) as { snapshotHash: string; stage: StageName };
  } catch {
    return NextResponse.json({ error: "INVALID_CALLBACK_PAYLOAD" }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "SUPABASE_NOT_CONFIGURED" }, { status: 503 });

  const leaseOwner = request.headers.get("upstash-message-id") ?? `lease:${analysisId}:${payload.stage}`;
  const claimed = await claimStage({
    analysisId,
    snapshotHash: payload.snapshotHash,
    stage: payload.stage,
    leaseOwner,
  });

  if (claimed.alreadyCompleted) {
    const { addOutboxStage, publishOutboxStage } = await import("@/lib/analysis/qstash-engine");
    const { data: completedRun } = await supabase
      .from("analysis_runs")
      .select("depth")
      .eq("id", analysisId)
      .eq("snapshot_hash", payload.snapshotHash)
      .maybeSingle();
    const nextStage = getNextStage(payload.stage, completedRun?.depth ?? "STANDARD");
    if (nextStage) {
      await addOutboxStage({ analysisId, snapshotHash: payload.snapshotHash, stage: nextStage, payload: { analysisId, snapshotHash: payload.snapshotHash, stage: nextStage } });
      await publishOutboxStage({ analysisId, snapshotHash: payload.snapshotHash, stage: nextStage });
    }
    return NextResponse.json({ status: "ALREADY_COMPLETED" });
  }
  if (claimed.leasedByAnother) return NextResponse.json({ status: "LEASED_BY_OTHER" }, { status: 202 });

  try {
    const { data: run, error: runError } = await supabase
      .from("analysis_runs")
      .select("snapshot_packet,snapshot_timestamp,snapshot_age_seconds,depth,status")
      .eq("id", analysisId)
      .eq("snapshot_hash", payload.snapshotHash)
      .maybeSingle();

    if (runError || !run) throw new Error("ANALYSIS_SNAPSHOT_NOT_FOUND");

    if (payload.stage === "SNAPSHOT_VALIDATION") {
      await completeStage({ analysisId, snapshotHash: payload.snapshotHash, stage: payload.stage, leaseOwner, result: { valid: true } });
    } else if (payload.stage === "RISK_VALIDATOR") {
      const { data: runStages } = await supabase
        .from("analysis_stage_results")
        .select("stage,status,result")
        .eq("analysis_id", analysisId)
        .eq("snapshot_hash", payload.snapshotHash);

      const judge = runStages?.find((stage) => stage.stage === "FINAL_JUDGE")?.result as Record<string, unknown> | undefined;
      const vetoes: string[] = [];
      if (!judge) vetoes.push("FINAL_JUDGE_RESULT_MISSING");
      if (runStages?.some((stage) => stage.status === "FAILED")) vetoes.push("FAILED_SPECIALIST_STAGE");

      const packet = run.snapshot_packet;
      const commodity = findXauCommodity(packet.commodities);
      if (commodity) {
        if (commodity.meta.spread_points > spreadLimitFor(commodity.meta.symbol)) vetoes.push("XAU_SPREAD_VETO");
        if (commodity.quant_regime.atr_14.M5 <= 0) vetoes.push("MISSING_ATR_M5");
      } else {
        vetoes.push("XAUUSD_NOT_FOUND");
      }

      await completeStage({ analysisId, snapshotHash: payload.snapshotHash, stage: payload.stage, leaseOwner, result: { vetoes } });
    } else if (payload.stage === "REPORT_COMPLETION") {
      const { data: runStages } = await supabase
        .from("analysis_stage_results")
        .select("stage,status,result")
        .eq("analysis_id", analysisId)
        .eq("snapshot_hash", payload.snapshotHash);

      const packet = run.snapshot_packet;
      const commodity = findXauCommodity(packet.commodities);
      if (!commodity) throw new Error("XAUUSD_NOT_FOUND");

      const context = buildXauMarketContext({ packet, commodity, snapshotHash: payload.snapshotHash, receivedAt: run.snapshot_timestamp, sourceTimestamp: run.snapshot_timestamp });
      const judge = runStages?.find((stage) => stage.stage === "FINAL_JUDGE")?.result as Record<string, unknown> | undefined;
      const risk = runStages?.find((stage) => stage.stage === "RISK_VALIDATOR")?.result as { vetoes?: string[] } | undefined;
      if (!judge) throw new Error("FINAL_JUDGE_RESULT_MISSING");

      const specialists = Object.fromEntries((runStages ?? []).filter((stage) => ["STRUCTURE_SPECIALIST", "VOLUME_SPECIALIST", "LIQUIDITY_SPECIALIST", "MACRO_SPECIALIST"].includes(stage.stage)).map((stage) => [stage.stage, stage.result]));
      const bullBear = Object.fromEntries((runStages ?? []).filter((stage) => ["BULL_ANALYST", "BEAR_ANALYST", "DEBATE"].includes(stage.stage)).map((stage) => [stage.stage, stage.result]));

      const report = buildReport({ context, judge, specialists, stages: bullBear });
      if ((risk?.vetoes ?? []).length > 0) {
        report.decision = "NO_TRADE";
        report.risk_vetoes = risk?.vetoes ?? [];
      }

      if (report.decision === "BUY" || report.decision === "SELL") {
        const proposal = {
          verdict: report.decision,
          entry_low: report.entry_zone?.low ?? undefined,
          entry_high: report.entry_zone?.high ?? undefined,
          stop_loss: report.stop_loss ?? undefined,
          tp1: report.tp1 ?? undefined,
          tp2: report.tp2 ?? undefined,
          tp3: report.tp3 ?? undefined,
        };
        const validation = validateEntryProposal({ proposal, bid: context.bid, ask: context.ask, spreadPoints: context.spread_points, spreadLimit: spreadLimitFor(context.symbol), atrM5: context.atr.M5, digits: context.digits, tickSize: context.tick_size });
        if (!validation.valid) {
          report.decision = "NO_TRADE";
          report.entry_zone = null;
          report.stop_loss = null;
          report.tp1 = null;
          report.tp2 = null;
          report.tp3 = null;
          report.risk_vetoes = [...(risk?.vetoes ?? []), ...validation.reasons];
        }
      }

      const { error: reportError } = await supabase.from("analysis_runs").update({ status: "COMPLETED", final_decision: report.decision, final_report: report, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", analysisId).eq("snapshot_hash", payload.snapshotHash);
      if (reportError) throw new Error(`FINAL_REPORT_SAVE_FAILED:${reportError.code}`);
      await completeStage({ analysisId, snapshotHash: payload.snapshotHash, stage: payload.stage, leaseOwner, result: { completed: true, final_decision: report.decision } });
    } else {
      const packet = run.snapshot_packet;
      const commodity = findXauCommodity(packet.commodities);
      if (!commodity) throw new Error("XAUUSD_NOT_FOUND");

      const context = buildXauMarketContext({
        packet,
        commodity,
        snapshotHash: payload.snapshotHash,
        receivedAt: run.snapshot_timestamp,
        sourceTimestamp: run.snapshot_timestamp,
      });

      const prompt = specialistPrompts[payload.stage] ?? "Analyze the supplied XAUUSD market snapshot.";
      const responseSchema = payload.stage === "FINAL_JUDGE"
        ? finalJudgeSchema
        : payload.stage === "BULL_ANALYST" || payload.stage === "BEAR_ANALYST"
          ? bullBearSchema
          : payload.stage === "DEBATE"
            ? debateSchema
            : specialistSchema;

      const rawResponse = await generateStructuredGeminiJson({
        systemInstruction: `${prompt}\nThe output must be valid for the supplied JSON schema. Never invent unavailable data. Synthetic CVD is not exchange order flow.`,
        contextJson: JSON.stringify(context),
        responseSchema: toJSONSchema(responseSchema),
      });

      let parsed;
      try {
        parsed = responseSchema.parse(rawResponse);
      } catch (error) {
        throw new Error(`INVALID_GEMINI_OUTPUT:${error instanceof Error ? error.message : "validation"}`);
      }

      await completeStage({ analysisId, snapshotHash: payload.snapshotHash, stage: payload.stage, leaseOwner, result: parsed });

      if (payload.stage === "FINAL_JUDGE") {
        await completeFinalReport({ supabase, analysisId, snapshotHash: payload.snapshotHash, leaseOwner, run });
      }
    }

    const nextStage = getNextStage(payload.stage, run.depth);
    if (nextStage) {
      const { addOutboxStage, publishOutboxStage } = await import("@/lib/analysis/qstash-engine");
      await addOutboxStage({ analysisId, snapshotHash: payload.snapshotHash, stage: nextStage, payload: { analysisId, snapshotHash: payload.snapshotHash, stage: nextStage } });
      await publishOutboxStage({ analysisId, snapshotHash: payload.snapshotHash, stage: nextStage });
    }

    return NextResponse.json({ status: "STAGE_COMPLETED", stage: payload.stage });
  } catch (error) {
    await failStage({
      analysisId,
      snapshotHash: payload.snapshotHash,
      stage: payload.stage,
      leaseOwner,
      providerError: error instanceof Error ? error.message : "UNKNOWN_STAGE_ERROR",
    });
    await supabase.from("analysis_runs").update({ status: "FAILED", error_code: "ANALYSIS_STAGE_FAILED", error_message: error instanceof Error ? error.message : "Unknown", updated_at: new Date().toISOString() }).eq("id", analysisId);

    const { data: failedRun } = await supabase
      .from("analysis_runs")
      .select("depth")
      .eq("id", analysisId)
      .maybeSingle();
    const day = new Date().toISOString().slice(0, 10);
    await supabase.rpc("refund_miras_analysis_budget", {
      p_day: day,
      p_depth: failedRun?.depth === "DEEP" ? "DEEP" : "STANDARD",
      p_refund: failedRun?.depth === "DEEP" ? 16 : 10,
      p_consumed: 0,
    });

    return NextResponse.json({ error: "ANALYSIS_STAGE_FAILED", stage: payload.stage }, { status: 500 });
  }
}
