import type { Commodity, MarketPacket } from "@/lib/market-schema";
import type { MarketContext } from "@/lib/analysis/types";

export function buildXauMarketContext(input: {
  packet: MarketPacket;
  commodity: Commodity;
  snapshotHash: string;
  receivedAt: string;
  sourceTimestamp: string;
}) {
  const { packet, commodity } = input;
  const sourceAgeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(input.sourceTimestamp)) / 1_000));

  const candles = Object.fromEntries(
    Object.entries(commodity.candles_data)
      .filter(([timeframe]) => ["D1", "H4", "H1", "M15", "M5"].includes(timeframe))
      .map(([timeframe, values]) => [timeframe, values.slice(-12)]),
  );

  const context: MarketContext = {
    snapshot_hash: input.snapshotHash,
    snapshot_timestamp: input.sourceTimestamp,
    snapshot_age_seconds: sourceAgeSeconds,
    source: "mt5",
    symbol: commodity.meta.symbol,
    bid: commodity.meta.bid,
    ask: commodity.meta.ask,
    digits: commodity.meta.digits,
    tick_size: commodity.meta.contract_specs.tick_size,
    spread_points: commodity.meta.spread_points,
    atr: commodity.quant_regime.atr_14,
    market_session: commodity.meta.market_session,
    in_killzone: commodity.meta.in_killzone,
    regime: commodity.quant_regime.detected_regime,
    indicators: {
      ema20_m15: commodity.indicators.ema20_m15,
      ema50_m15: commodity.indicators.ema50_m15,
      ema200_h1: commodity.indicators.ema200_h1,
      rsi14_m15: commodity.indicators.rsi14_m15,
      rsi14_h1: commodity.indicators.rsi14_h1,
      corr_dxy_h1: commodity.indicators.corr_dxy_h1,
      corr_xag_h1: commodity.indicators.corr_xag_h1,
      hurst_m15: commodity.quant_regime.hurst_m15,
      hurst_h1: commodity.quant_regime.hurst_h1,
    },
    structure: commodity.smc_structure,
    liquidity: {
      ...commodity.liquidity_pools,
      sweeps: Object.entries(commodity.liquidity_pools)
        .filter(([, value]) => typeof value === "object" && value !== null && "swept" in value && value.swept)
        .map(([name]) => name),
    },
    volume: {
      poc_level: commodity.microstructure_volume.poc_level,
      va_high: commodity.microstructure_volume.va_high,
      va_low: commodity.microstructure_volume.va_low,
      daily_vwap: commodity.microstructure_volume.daily_vwap,
      vwap_slope: commodity.microstructure_volume.vwap_slope,
      synthetic_cvd_session: commodity.microstructure_volume.synthetic_cvd_session,
      synthetic_cvd_m15: commodity.microstructure_volume.synthetic_cvd_m15,
      rvol_m15: commodity.microstructure_volume.rvol_m15,
      dom_buy_pressure_pct: commodity.microstructure_volume.dom_buy_pressure_pct,
      state: commodity.microstructure_volume.state,
      limitation: "synthetic CVD only; not exchange-verified order flow",
    },
    intermarket: packet.intermarket,
    candles,
  };

  return context;
}
