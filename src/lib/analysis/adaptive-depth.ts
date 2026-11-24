import type { MarketContext, AnalysisDepth } from "@/lib/analysis/types";

export type AdaptiveDepthResult = {
  depth: AnalysisDepth;
  reasons: string[];
};

export function selectAdaptiveDepth(context: MarketContext, overrides: { spreadLimit: number }): AdaptiveDepthResult {
  const reasons: string[] = [];

  if (context.snapshot_age_seconds > 45) {
    reasons.push("Snapshot age exceeds MT5 45-second limit.");
  }
  if (context.spread_points > overrides.spreadLimit) {
    reasons.push("Spread exceeds the broker-specific XAUUSD limit.");
  }
  if (!context.atr.M5 || !context.atr.M15 || !context.atr.H1) {
    reasons.push("Required ATR timeframe is missing.");
  }

  if (reasons.length > 0) {
    return { depth: "PROTECTIVE", reasons };
  }

  const structure = context.structure as {
    macro?: { trend_bias?: string };
    micro?: { trend_bias?: string };
  };
  if (structure.macro?.trend_bias && structure.micro?.trend_bias && structure.macro.trend_bias !== structure.micro.trend_bias && structure.micro.trend_bias !== "NEUTRAL") {
    reasons.push("Macro and micro structure conflict.");
  }

  const volume = context.volume as { rvol_m15?: number; state?: string };
  if ((volume.rvol_m15 ?? 0) >= 2) {
    reasons.push("RVOL M15 is elevated and may signal unusual participation.");
  }

  const liquidity = context.liquidity as { sweeps?: unknown[] };
  if (Array.isArray(liquidity.sweeps) && liquidity.sweeps.length > 0) {
    reasons.push("Recent liquidity sweep increases uncertainty.");
  }

  if (reasons.length > 0) return { depth: "DEEP", reasons };
  return { depth: "STANDARD", reasons: ["Snapshot is live, complete, and no major deterministic conflict was detected."] };
}
