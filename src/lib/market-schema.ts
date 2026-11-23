import { z } from "zod";

const finite = z.number().finite();
const nullableFinite = finite.nullable();

const contractSpecsSchema = z
  .object({
    contract_size: finite.positive(),
    tick_value: finite.positive(),
    tick_size: finite.positive(),
    min_lot: finite.positive(),
    lot_step: finite.positive(),
  })
  .passthrough();

const candleSchema = z
  .object({
    t: z.string().min(1).max(32),
    o: finite,
    h: finite,
    l: finite,
    c: finite,
    v: finite.nonnegative(),
  })
  .passthrough();

const liquidityLevelSchema = z
  .object({ price: finite, swept: z.boolean() })
  .passthrough()
  .nullable();

const marketZoneSchema = z
  .object({
    low: finite,
    high: finite,
    status: z.string().min(1).max(32),
  })
  .passthrough()
  .nullable();

const structureLayerSchema = z
  .object({
    tf: z.string().min(1),
    trend_bias: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
    bos_level: finite,
    choch_level: finite,
    nearest_fvg_bullish: marketZoneSchema,
    nearest_fvg_bearish: marketZoneSchema,
    nearest_ob_bullish: marketZoneSchema,
    nearest_ob_bearish: marketZoneSchema,
  })
  .passthrough();

const commoditySchema = z
  .object({
    meta: z
      .object({
        symbol: z.string().trim().min(1).max(32),
        digits: z.number().int().min(0).max(12),
        market_session: z.string().min(1),
        in_killzone: z.boolean(),
        bid: finite.positive(),
        ask: finite.positive(),
        spread_points: finite.nonnegative(),
        spread_usd: finite.nonnegative(),
        spread_status: z.string().min(1),
        daily_change_percent: finite,
        contract_specs: contractSpecsSchema,
      })
      .passthrough(),
    basis: z
      .object({
        futures_price: nullableFinite,
        basis_spread_usd: nullableFinite,
      })
      .passthrough(),
    quant_regime: z
      .object({
        hurst_m15: finite.min(0).max(1),
        hurst_h1: finite.min(0).max(1),
        detected_regime: z.enum(["TRENDING", "MEAN_REVERTING", "NOISE"]),
        atr_14: z
          .object({ M5: finite.nonnegative(), M15: finite.nonnegative(), H1: finite.nonnegative(), D1: finite.nonnegative() })
          .passthrough(),
        adr_14: finite.nonnegative(),
        daily_range_exhaustion_pct: finite.nonnegative(),
      })
      .passthrough(),
    indicators: z
      .object({
        ema20_m15: nullableFinite,
        ema50_m15: nullableFinite,
        ema200_h1: nullableFinite,
        rsi14_m15: finite.min(0).max(100),
        rsi14_h1: finite.min(0).max(100),
        corr_dxy_h1: finite.min(-1).max(1),
        corr_xag_h1: finite.min(-1).max(1),
      })
      .passthrough(),
    microstructure_volume: z
      .object({
        poc_level: nullableFinite,
        va_high: nullableFinite,
        va_low: nullableFinite,
        daily_vwap: nullableFinite,
        vwap_upper_1sd: nullableFinite,
        vwap_lower_1sd: nullableFinite,
        vwap_upper_2sd: nullableFinite,
        vwap_lower_2sd: nullableFinite,
        vwap_slope: z.enum(["UP", "DOWN", "FLAT"]),
        synthetic_cvd_session: finite,
        synthetic_cvd_m15: finite,
        rvol_m15: finite.nonnegative(),
        dom_buy_pressure_pct: nullableFinite,
        state: z.string().min(1),
      })
      .passthrough(),
    smc_structure: z
      .object({ macro: structureLayerSchema, micro: structureLayerSchema })
      .passthrough(),
    liquidity_pools: z
      .object({
        ny_midnight_open: nullableFinite,
        ny_830_am_open: nullableFinite,
        pdh: liquidityLevelSchema,
        pdl: liquidityLevelSchema,
        pwh: liquidityLevelSchema,
        pwl: liquidityLevelSchema,
        asian_high: liquidityLevelSchema,
        asian_low: liquidityLevelSchema,
        london_high: liquidityLevelSchema,
        london_low: liquidityLevelSchema,
      })
      .passthrough(),
    candles_data: z.record(z.string().min(1), z.array(candleSchema).max(500)),
  })
  .passthrough()
  .superRefine((commodity, context) => {
    if (commodity.meta.ask < commodity.meta.bid) {
      context.addIssue({ code: "custom", path: ["meta", "ask"], message: "Ask must be greater than or equal to bid" });
    }
    const { va_high: valueAreaHigh, va_low: valueAreaLow } = commodity.microstructure_volume;
    if (valueAreaHigh !== null && valueAreaLow !== null && valueAreaHigh < valueAreaLow) {
      context.addIssue({ code: "custom", path: ["microstructure_volume", "va_high"], message: "va_high must be greater than or equal to va_low" });
    }
  });

/** Exact envelope used by the supplied MT5 Schema 2.1 sample. Unknown extra
 * fields are preserved for forward compatibility, while calculation inputs
 * and high-volume candle data are validated explicitly.
 */
export const marketPacketSchema = z
  .object({
    schema_version: z.literal("2.1"),
    broker: z.string().optional(),
    utc_timestamp: z.string().datetime({ offset: true }),
    server_utc_offset_hours: finite.min(-12).max(14),
    target_strategy: z.string().min(1).max(64),
    intermarket: z
      .object({
        dxy_price: finite.positive().nullable(),
        dxy_change_pct: nullableFinite,
        xau_xag_ratio: finite.positive().nullable(),
      })
      .passthrough(),
    commodities: z.record(z.string().min(1).max(32), commoditySchema),
    diagnostics: z
      .object({ processing_time_sec: finite.nonnegative(), status: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((packet, context) => {
    const symbols = Object.entries(packet.commodities);
    if (symbols.length === 0 || symbols.length > 32) {
      context.addIssue({ code: "custom", path: ["commodities"], message: "Expected between 1 and 32 commodity entries" });
    }
    for (const [key, commodity] of symbols) {
      if (commodity.meta.symbol.toUpperCase() !== key.toUpperCase()) {
        context.addIssue({
          code: "custom",
          path: ["commodities", key, "meta", "symbol"],
          message: "meta.symbol must match its commodities key",
        });
      }
    }
  });

export type MarketPacket = z.infer<typeof marketPacketSchema>;
export type Commodity = z.infer<typeof commoditySchema>;
