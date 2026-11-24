import { describe, expect, it } from "vitest";
import { findXauCommodity, normalizeXauSymbol } from "@/lib/xau-symbol";
import { validateEntryProposal } from "@/lib/analysis/entry-validator";
import { selectAdaptiveDepth } from "@/lib/analysis/adaptive-depth";

describe("XAU symbol normalization", () => {
  it("accepts exact and safe broker suffix forms", () => {
    expect(normalizeXauSymbol("XAUUSD")).toBe("XAUUSD");
    expect(normalizeXauSymbol("XAUUSD.m")).toBe("XAUUSD");
    expect(normalizeXauSymbol(" xauusd-raw ")).toBe("XAUUSD");
  });

  it("rejects unrelated and unsafe symbols", () => {
    expect(normalizeXauSymbol("XAGUSD")).toBeNull();
    expect(normalizeXauSymbol("XAUUSD.m.extra")).toBeNull();
    expect(normalizeXauSymbol("EURUSD")).toBeNull();
  });

  it("finds only exact XAU key and matching metadata", () => {
    const commodity = { meta: { symbol: "XAUUSD.m" } } as never;
    expect(findXauCommodity({ "XAUUSD.m": commodity })).toBe(commodity);
  });
});

describe("deterministic entry validation", () => {
  const base = { bid: 3617.80, ask: 3617.90, spreadPoints: 10, spreadLimit: 35, atrM5: 4, digits: 2, tickSize: 0.01 };

  it("accepts a valid BUY that accounts for Ask", () => {
    expect(validateEntryProposal({ ...base, proposal: { verdict: "BUY", entry_low: 3618.0, entry_high: 3618.2, stop_loss: 3617.0, tp1: 3620.0, tp2: 3621.5 } }).valid).toBe(true);
  });

  it("rejects an invalid BUY stop and distant entry", () => {
    expect(validateEntryProposal({ ...base, proposal: { verdict: "BUY", entry_low: 3622.0, entry_high: 3622.2, stop_loss: 3622.1, tp1: 3624.0 } }).valid).toBe(false);
  });

  it("rejects spread veto and WAIT remains valid", () => {
    expect(validateEntryProposal({ ...base, spreadPoints: 36, proposal: { verdict: "SELL", entry_low: 3615, entry_high: 3616, stop_loss: 3618, tp1: 3613 } }).reasons).toContain("SPREAD_VETO");
    expect(validateEntryProposal({ ...base, proposal: { verdict: "WAIT" } }).valid).toBe(true);
  });
});

describe("adaptive depth", () => {
  const baseContext = {
    snapshot_hash: "0".repeat(64), snapshot_timestamp: "2026-11-24T00:00:00Z", snapshot_age_seconds: 5,
    source: "mt5" as const, symbol: "XAUUSD", bid: 3617.8, ask: 3617.9, digits: 2, tick_size: 0.01,
    spread_points: 10, atr: { M5: 4, M15: 8, H1: 20, D1: 100 }, market_session: "London", in_killzone: true,
    regime: "NOISE" as const, indicators: {}, structure: { macro: { trend_bias: "BULLISH" }, micro: { trend_bias: "BULLISH" } },
    liquidity: {}, volume: { rvol_m15: 0.5 }, intermarket: {}, candles: {},
  };

  it("chooses STANDARD for normal conditions", () => {
    expect(selectAdaptiveDepth(baseContext, { spreadLimit: 35 }).depth).toBe("STANDARD");
  });

  it("chooses PROTECTIVE for stale or spread veto", () => {
    expect(selectAdaptiveDepth({ ...baseContext, snapshot_age_seconds: 46 }, { spreadLimit: 35 }).depth).toBe("PROTECTIVE");
    expect(selectAdaptiveDepth({ ...baseContext, spread_points: 36 }, { spreadLimit: 35 }).depth).toBe("PROTECTIVE");
  });

  it("chooses DEEP for conflicting structure", () => {
    expect(selectAdaptiveDepth({ ...baseContext, structure: { macro: { trend_bias: "BULLISH" }, micro: { trend_bias: "BEARISH" } } }, { spreadLimit: 35 }).depth).toBe("DEEP");
  });
});
