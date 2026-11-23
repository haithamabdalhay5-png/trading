/**
 * Deterministic risk configuration shared by the API and the dashboard.
 * Pure module: no I/O, safe to import from client components and tests.
 */

/** Max allowed spread per instrument, in broker points. Above it the spread veto fires. */
export const SPREAD_LIMITS_POINTS = {
  XAUUSD: 35, // 0.35$
  XAGUSD: 50, // 0.050$
  XPTUSD: 320, // platinum normally trades ~200-300 points; a gold-sized cap would veto it permanently
} as const;

/** Fallback for any symbol that is not one of the three active instruments. */
export const DEFAULT_SPREAD_LIMIT_POINTS = 35;

/** MT5 live feed is considered offline when the packet timestamp is older than this. */
export const MT5_LIVE_MAX_AGE_SECONDS = 45;

/** The Drive backup is only for visibility; it is refreshed far less often than MT5 live. */
export const DRIVE_MAX_AGE_SECONDS = 90;

/** Allowed clock skew for packets timestamped slightly in the future. */
export const FUTURE_CLOCK_SKEW_SECONDS = 30;

export type SpreadLevel = "ok" | "veto";

export type SpreadEvaluation = {
  limit: number;
  level: SpreadLevel;
};

/** Matches by prefix so broker suffixes such as `XAUUSD.m` still resolve to the right limit. */
export function spreadLimitFor(symbol: string): number {
  const upper = symbol.trim().toUpperCase();
  for (const [base, limit] of Object.entries(SPREAD_LIMITS_POINTS)) {
    if (upper.startsWith(base)) return limit;
  }
  return DEFAULT_SPREAD_LIMIT_POINTS;
}

export function evaluateSpread(symbol: string, spreadPoints: number | undefined): SpreadEvaluation {
  const limit = spreadLimitFor(symbol);
  const known = typeof spreadPoints === "number" && Number.isFinite(spreadPoints);
  return { limit, level: known && spreadPoints > limit ? "veto" : "ok" };
}
