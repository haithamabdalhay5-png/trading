import { NextResponse } from "next/server";
import { hasSupabaseConfig, readLatestXauSnapshot } from "@/lib/supabase-market-store";
import { hasUpstashConfig, readDriveFallbackSnapshot, storeDriveFallbackSnapshot, tryAcquireDriveRefresh } from "@/lib/market-storage";
import { fetchSharedDriveSnapshot, getSharedDriveFileId } from "@/lib/google-drive-source";
import { MT5_LIVE_MAX_AGE_SECONDS } from "@/lib/risk-config";

export async function GET(request: Request) {
  void request.headers.get("x-request-id");

  const supabaseConfigured = hasSupabaseConfig();
  const redisConfigured = hasUpstashConfig();

  try {
    if (supabaseConfigured) {
      const live = await readLatestXauSnapshot();
      if (live) {
        const packetAge = Math.max(0, Math.floor((Date.now() - Date.parse(live.source_timestamp)) / 1_000));
        const mt5Live = packetAge <= MT5_LIVE_MAX_AGE_SECONDS;
        return NextResponse.json({
          snapshot: null,
          xau: {
            symbol: live.symbol,
            bid: live.bid,
            ask: live.ask,
            spread_points: live.spread_points,
            digits: live.digits,
            tick_size: live.tick_size,
            market_session: live.market_session,
            market_regime: live.market_regime,
            packet_timestamp: live.source_timestamp,
          },
          age_seconds: packetAge,
          source_age_seconds: packetAge,
          stale: !mt5Live,
          mt5_live: mt5Live,
          recommendations_locked: !mt5Live,
          ...(mt5Live ? {} : { error_code: "ERR_MT5_OFFLINE" }),
          health: {
            mt5: mt5Live ? "connected" : "offline",
            drive: getSharedDriveFileId() ? "waiting" : "not_configured",
            redis: redisConfigured ? "connected" : "not_configured",
            supabase: "configured",
          },
        });
      }
    }

    const cachedDrive = await readDriveFallbackSnapshot().catch(() => null);
    let driveSnapshot = cachedDrive;
    const fileId = getSharedDriveFileId();
    if (fileId && (!cachedDrive || cachedDrive.receivedAt && Date.now() - Date.parse(cachedDrive.receivedAt) >= 45_000) && await tryAcquireDriveRefresh().catch(() => false)) {
      try {
        const fresh = await fetchSharedDriveSnapshot(fileId);
        await storeDriveFallbackSnapshot(fresh);
        driveSnapshot = fresh;
      } catch {
        // Drive remains visible only; it never unlocks analysis.
      }
    }

    const driveCommodity = driveSnapshot ? Object.values(driveSnapshot.packet.commodities).find((commodity) => commodity.meta.symbol.toUpperCase().startsWith("XAUUSD")) : null;
    return NextResponse.json({
      snapshot: null,
      xau: driveCommodity && driveSnapshot ? {
        symbol: driveCommodity.meta.symbol,
        bid: driveCommodity.meta.bid,
        ask: driveCommodity.meta.ask,
        spread_points: driveCommodity.meta.spread_points,
        digits: driveCommodity.meta.digits,
        tick_size: driveCommodity.meta.contract_specs.tick_size,
        market_session: driveCommodity.meta.market_session,
        market_regime: driveCommodity.quant_regime.detected_regime,
        packet_timestamp: driveSnapshot.packet.utc_timestamp,
      } : null,
      age_seconds: undefined,
      stale: true,
      mt5_live: false,
      recommendations_locked: true,
      error_code: "ERR_MT5_OFFLINE",
      health: {
        mt5: "waiting",
        drive: fileId ? "connected" : "not_configured",
        redis: redisConfigured ? "connected" : "not_configured",
        supabase: supabaseConfigured ? "configured" : "not_configured",
      },
    });
  } catch {
    return NextResponse.json({
      snapshot: null,
      xau: null,
      stale: true,
      mt5_live: false,
      recommendations_locked: true,
      error_code: "ERR_MT5_OFFLINE",
      health: {
        mt5: "unknown",
        drive: getSharedDriveFileId() ? "unknown" : "not_configured",
        redis: redisConfigured ? "error" : "not_configured",
        supabase: supabaseConfigured ? "error" : "not_configured",
      },
      error: "LIVE_STORAGE_UNAVAILABLE",
    }, { status: 503 });
  }
}
