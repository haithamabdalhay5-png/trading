import { ALERT_RULES, evaluatePacket } from "@/lib/alert-rules";
import { acquireLock, releaseLock, type StoredSnapshot } from "@/lib/market-storage";
import { MT5_LIVE_MAX_AGE_SECONDS } from "@/lib/risk-config";

/** Set when an outage alert was sent; removed when the feed returns so the recovery message fires once. */
export const OFFLINE_LOCK_KEY = "monitor:offline-alert";
const OFFLINE_REMINDER_SECONDS = 6 * 3600;

/**
 * Runs after every accepted ingest. Costs no extra Redis reads: the previous snapshot comes back
 * from the same SET ... GET command that stored the new one. Redis is touched again only when an
 * alert fires (cooldown lock) or the feed returns after a gap.
 */
export async function runMonitor(current: StoredSnapshot, previous: StoredSnapshot | null): Promise<void> {
  const gapSeconds = previous
    ? (Date.parse(current.receivedAt) - Date.parse(previous.receivedAt)) / 1_000
    : Number.POSITIVE_INFINITY;

  // The feed came back after an outage that we already reported.
  if (gapSeconds > MT5_LIVE_MAX_AGE_SECONDS) {
    await releaseLock(OFFLINE_LOCK_KEY);
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

  // Monitoring events remain server-side and visible in the dashboard.
  // Telegram sending is intentionally handled only by the manual report endpoint.
  for (const [symbol, lines] of grouped) {
    console.info(`[monitor] ${symbol}: ${lines.join(" | ")}`);
  }
}

/** Called by the external heartbeat pinger; reports an outage once, then once per 6 hours. */
export async function checkFeedHealth(latest: StoredSnapshot | null): Promise<"ok" | "offline_alerted" | "offline_already_alerted" | "no_data"> {
  if (!latest) return "no_data";
  const ageSeconds = Math.floor((Date.now() - Date.parse(latest.packet.utc_timestamp)) / 1_000);
  if (ageSeconds <= MT5_LIVE_MAX_AGE_SECONDS) return "ok";
  if (!(await acquireLock(OFFLINE_LOCK_KEY, OFFLINE_REMINDER_SECONDS))) return "offline_already_alerted";
  return "offline_alerted";
}
