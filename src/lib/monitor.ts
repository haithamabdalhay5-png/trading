import { ALERT_RULES, buildAlertMessage, evaluatePacket } from "@/lib/alert-rules";
import { acquireLock, releaseLock, type StoredSnapshot } from "@/lib/market-storage";
import { MT5_LIVE_MAX_AGE_SECONDS } from "@/lib/risk-config";
import { hasTelegramConfig, sendTelegram } from "@/lib/telegram";

/** Set when an outage alert was sent; removed when the feed returns so the recovery message fires once. */
export const OFFLINE_LOCK_KEY = "monitor:offline-alert";
const OFFLINE_REMINDER_SECONDS = 6 * 3600;

/**
 * Runs after every accepted ingest. Costs no extra Redis reads: the previous snapshot comes back
 * from the same SET ... GET command that stored the new one. Redis is touched again only when an
 * alert fires (cooldown lock) or the feed returns after a gap.
 */
export async function runMonitor(current: StoredSnapshot, previous: StoredSnapshot | null): Promise<void> {
  if (!hasTelegramConfig()) return;

  const gapSeconds = previous
    ? (Date.parse(current.receivedAt) - Date.parse(previous.receivedAt)) / 1_000
    : Number.POSITIVE_INFINITY;

  // The feed came back after an outage that we already reported.
  if (gapSeconds > MT5_LIVE_MAX_AGE_SECONDS && (await releaseLock(OFFLINE_LOCK_KEY))) {
    await sendTelegram("✅ عاد بث MT5 وتستأنف المراقبة.");
  }

  // After a long gap the previous state is unknown; do not compare across it.
  if (!previous || gapSeconds > ALERT_RULES.maxPreviousGapSeconds) return;

  const events = evaluatePacket(current.packet, previous.packet);
  if (events.length === 0) return;

  const grouped = new Map<string, string[]>();
  for (const event of events) {
    const cooldownKey = `monitor:cd:${event.symbol}:${event.type}:${event.detail}`;
    if (!(await acquireLock(cooldownKey, ALERT_RULES.cooldownSeconds))) continue;
    grouped.set(event.symbol, [...(grouped.get(event.symbol) ?? []), event.line]);
  }

  const appUrl = process.env.APP_URL;
  for (const [symbol, lines] of grouped) {
    const commodity = Object.values(current.packet.commodities).find((item) => item.meta.symbol === symbol);
    const price = commodity ? commodity.meta.bid.toFixed(commodity.meta.digits) : "";
    if (!(await sendTelegram(buildAlertMessage(symbol, price, lines, appUrl)))) {
      console.error("[monitor] telegram send failed for", symbol);
    }
  }
}

/** Called by the external heartbeat pinger; reports an outage once, then once per 6 hours. */
export async function checkFeedHealth(latest: StoredSnapshot | null): Promise<"ok" | "offline_alerted" | "offline_already_alerted" | "no_data"> {
  if (!latest) return "no_data";
  const ageSeconds = Math.floor((Date.now() - Date.parse(latest.packet.utc_timestamp)) / 1_000);
  if (ageSeconds <= MT5_LIVE_MAX_AGE_SECONDS) return "ok";
  if (!(await acquireLock(OFFLINE_LOCK_KEY, OFFLINE_REMINDER_SECONDS))) return "offline_already_alerted";
  await sendTelegram(`🔴 انقطع بث MT5 منذ ${ageSeconds} ثانية. الحالة ERR_MT5_OFFLINE وزر التحليل مقفل.`);
  return "offline_alerted";
}
