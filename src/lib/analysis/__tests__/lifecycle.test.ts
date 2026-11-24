import { describe, expect, it } from "vitest";
import { buildReport } from "@/lib/analysis/report-builder";
import type { MarketContext } from "@/lib/analysis/types";

const context: MarketContext = {
  snapshot_hash: "a".repeat(64), snapshot_timestamp: "2026-11-24T09:30:00Z", snapshot_age_seconds: 3,
  source: "mt5", symbol: "XAUUSD", bid: 3617.8, ask: 3617.9, digits: 2, tick_size: 0.01, spread_points: 10,
  atr: { M5: 4, M15: 8, H1: 20, D1: 100 }, market_session: "London", in_killzone: true,
  regime: "NOISE", indicators: {}, structure: {}, liquidity: {}, volume: {}, intermarket: {}, candles: {},
};

describe("final report construction", () => {
  it("returns NO_TRADE without inventing levels", () => {
    const report = buildReport({ context, judge: { decision: "NO_TRADE", confidence: "LOW", evidence_strength: "LOW", main_reasoning: ["No evidence conflict resolved"], risks: ["Incomplete liquidity evidence"], invalidation: ["Snapshot expiry"] }, specialists: {}, stages: {} });
    expect(report.decision).toBe("NO_TRADE");
    expect(report.entry_zone).toBeNull();
    expect(report.stop_loss).toBeNull();
  });

  it("builds deterministic BUY levels and R:R", () => {
    const report = buildReport({ context, judge: { decision: "BUY", confidence: "MEDIUM", evidence_strength: "MEDIUM", main_reasoning: ["Structure aligned"], risks: ["Volatility"], invalidation: ["Ask breaks structure"] }, specialists: {}, stages: {} });
    expect(report.decision).toBe("BUY");
    expect(report.stop_loss).not.toBeNull();
    expect(report.tp1).not.toBeNull();
    expect(report.risk_reward).not.toBeNull();
  });

  it("stores immutable snapshot metadata", () => {
    const report = buildReport({ context, judge: { decision: "WAIT", confidence: "MEDIUM", evidence_strength: "MEDIUM", main_reasoning: ["Trigger pending"] }, specialists: {}, stages: {} });
    expect(report.snapshot_hash).toBe("a".repeat(64));
    expect(report.data_source).toBe("mt5");
  });
});
