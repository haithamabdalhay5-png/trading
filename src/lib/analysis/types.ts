export type AnalysisDepth = "PROTECTIVE" | "STANDARD" | "DEEP";
export type FinalDecision = "BUY" | "SELL" | "WAIT" | "NO_TRADE";

export type MarketContext = {
  snapshot_hash: string;
  snapshot_timestamp: string;
  snapshot_age_seconds: number;
  source: "mt5";
  symbol: string;
  bid: number;
  ask: number;
  digits: number;
  tick_size: number;
  spread_points: number;
  atr: { M5: number; M15: number; H1: number; D1: number };
  market_session: string;
  in_killzone: boolean;
  regime: "TRENDING" | "MEAN_REVERTING" | "NOISE";
  indicators: Record<string, number | null>;
  structure: Record<string, unknown>;
  liquidity: Record<string, unknown>;
  volume: Record<string, unknown>;
  intermarket: Record<string, unknown>;
  candles: Record<string, unknown>;
};
