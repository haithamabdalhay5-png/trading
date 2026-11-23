import type { MarketPacket } from "./market-schema";

/**
 * Deterministic monitoring rules. Pure module: no I/O, no AI calls.
 * Alerts only say "something happened, press Analyze"; they never produce a recommendation.
 * Thresholds live here so they can be tuned in one place.
 */
export const ALERT_RULES = {
  /** Strong move: |close(last) - open(N candles ago)| on M5 >= this multiple of ATR14(M5). */
  strongMoveAtrMultiple: 1.5,
  strongMoveCandles: 3,
  /** RVOL (M15) crossing up through this value. */
  rvolSpike: 2,
  /** Daily range exhaustion (%) crossing up through this value. */
  adrExhaustionPct: 100,
  /** Same symbol + same event is not repeated within this window. */
  cooldownSeconds: 3600,
  /** If the previous packet is older than this, skip transition alerts (feed was down, state is unknown). */
  maxPreviousGapSeconds: 120,
} as const;

export type AlertType = "strong_move" | "liquidity_sweep" | "structure_shift" | "rvol_spike" | "adr_exhaustion";

export type AlertEvent = {
  symbol: string;
  type: AlertType;
  /** Part of the cooldown key, e.g. the swept level or the move direction. */
  detail: string;
  line: string;
};

const LIQUIDITY_LABELS: Record<string, string> = {
  pdh: "أعلى سعر أمس (PDH)",
  pdl: "أدنى سعر أمس (PDL)",
  pwh: "أعلى سعر الأسبوع الماضي (PWH)",
  pwl: "أدنى سعر الأسبوع الماضي (PWL)",
  asian_high: "قمة آسيا",
  asian_low: "قاع آسيا",
  london_high: "قمة لندن",
  london_low: "قاع لندن",
};

const BIAS_LABELS: Record<string, string> = { BULLISH: "صاعد", BEARISH: "هابط", NEUTRAL: "محايد" };

type Commodity = MarketPacket["commodities"][string];

function findCommodity(packet: MarketPacket, symbol: string): Commodity | undefined {
  const wanted = symbol.toUpperCase();
  return Object.values(packet.commodities).find((item) => item.meta.symbol.toUpperCase() === wanted);
}

function sweptFlag(commodity: Commodity, key: string): boolean | null {
  const level = (commodity.liquidity_pools as Record<string, unknown>)[key];
  if (level && typeof level === "object" && "swept" in level) return Boolean((level as { swept: unknown }).swept);
  return null;
}

/** Compares the new packet with the previous one and returns what newly happened. */
export function evaluatePacket(packet: MarketPacket, previous: MarketPacket | null): AlertEvent[] {
  if (!previous) return [];
  const events: AlertEvent[] = [];

  for (const current of Object.values(packet.commodities)) {
    const symbol = current.meta.symbol;
    const before = findCommodity(previous, symbol);
    if (!before) continue;
    const digits = current.meta.digits;

    // 1) Strong move: M5 displacement relative to ATR.
    const candles = current.candles_data["M5"] ?? [];
    const count = ALERT_RULES.strongMoveCandles;
    const atr = current.quant_regime.atr_14.M5;
    if (candles.length >= count && atr > 0) {
      const move = candles[candles.length - 1].c - candles[candles.length - count].o;
      const multiple = Math.abs(move) / atr;
      if (multiple >= ALERT_RULES.strongMoveAtrMultiple) {
        const up = move > 0;
        events.push({
          symbol,
          type: "strong_move",
          detail: up ? "up" : "down",
          line: `حركة قوية ${up ? "صاعدة" : "هابطة"}: ${multiple.toFixed(1)}× ATR خلال آخر ${count} شموع M5 (${up ? "+" : "-"}${Math.abs(move).toFixed(digits)})`,
        });
      }
    }

    // 2) Liquidity sweep: a level that was not swept before and is swept now.
    for (const key of Object.keys(LIQUIDITY_LABELS)) {
      const now = sweptFlag(current, key);
      const was = sweptFlag(before, key);
      if (now === true && was === false) {
        events.push({ symbol, type: "liquidity_sweep", detail: key, line: `سحب سيولة: ${LIQUIDITY_LABELS[key]}` });
      }
    }

    // 3) Structure shift on the macro timeframe (to a directional bias).
    const biasNow = current.smc_structure.macro.trend_bias;
    const biasBefore = before.smc_structure.macro.trend_bias;
    if (biasNow !== biasBefore && biasNow !== "NEUTRAL") {
      const tf = current.smc_structure.macro.tf.replace("PERIOD_", "");
      events.push({
        symbol,
        type: "structure_shift",
        detail: biasNow,
        line: `تحوّل هيكل ${tf}: ${BIAS_LABELS[biasBefore] ?? biasBefore} ← ${BIAS_LABELS[biasNow] ?? biasNow}`,
      });
    }

    // 4) Relative volume spike (crossing up).
    const rvolNow = current.microstructure_volume.rvol_m15;
    const rvolBefore = before.microstructure_volume.rvol_m15;
    if (rvolNow >= ALERT_RULES.rvolSpike && rvolBefore < ALERT_RULES.rvolSpike) {
      events.push({ symbol, type: "rvol_spike", detail: "rvol", line: `ارتفاع حجم غير عادي: RVOL M15 = ${rvolNow.toFixed(2)}×` });
    }

    // 5) Daily range exhaustion (crossing up).
    const adrNow = current.quant_regime.daily_range_exhaustion_pct;
    const adrBefore = before.quant_regime.daily_range_exhaustion_pct;
    if (adrNow >= ALERT_RULES.adrExhaustionPct && adrBefore < ALERT_RULES.adrExhaustionPct) {
      events.push({ symbol, type: "adr_exhaustion", detail: "adr", line: `استنفاد النطاق اليومي: ${adrNow.toFixed(0)}% من ADR` });
    }
  }
  return events;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One Telegram message per symbol, so several events in the same packet do not spam. */
export function buildAlertMessage(symbol: string, price: string, lines: string[], appUrl?: string): string {
  const parts = [
    `🔔 <b>${escapeHtml(symbol)}</b> · ${escapeHtml(price)}`,
    ...lines.map((line) => `• ${escapeHtml(line)}`),
    "👉 افتح مِرصد واضغط «تحليل» لتقييم الوضع",
  ];
  if (appUrl) parts.push(escapeHtml(appUrl));
  parts.push("<i>تنبيه مراقبة فقط وليس توصية.</i>");
  return parts.join("\n");
}
