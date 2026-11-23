import { NextResponse } from "next/server";
import {
  hasSupabaseConfig,
  hasUpstashConfig,
  readLatestSnapshot,
} from "@/lib/market-storage";

export async function GET() {
  const configured = hasUpstashConfig();
  if (!configured) {
    return NextResponse.json({
      snapshot: null,
      health: { mt5: "not_configured", redis: "not_configured", supabase: hasSupabaseConfig() ? "configured" : "not_configured" },
    });
  }

  try {
    const snapshot = await readLatestSnapshot();
    if (!snapshot) {
      return NextResponse.json({
        snapshot: null,
        health: { mt5: "waiting", redis: "connected", supabase: hasSupabaseConfig() ? "configured" : "not_configured" },
      });
    }

    const receivedAtMs = Date.parse(snapshot.receivedAt);
    const sourceAtMs = Date.parse(snapshot.packet.utc_timestamp);
    const ageSeconds = Math.max(0, Math.floor((Date.now() - receivedAtMs) / 1_000));
    const sourceAgeSeconds = Math.floor((Date.now() - sourceAtMs) / 1_000);
    return NextResponse.json({
      snapshot,
      age_seconds: ageSeconds,
      source_age_seconds: sourceAgeSeconds,
      stale: sourceAgeSeconds > 90 || sourceAgeSeconds < -30,
      health: {
        mt5: ageSeconds <= 30 ? "connected" : "offline",
        redis: "connected",
        supabase: hasSupabaseConfig() ? "configured" : "not_configured",
      },
    });
  } catch {
    return NextResponse.json({
      snapshot: null,
      health: { mt5: "unknown", redis: "error", supabase: hasSupabaseConfig() ? "configured" : "not_configured" },
      error: "LIVE_STORAGE_UNAVAILABLE",
    }, { status: 503 });
  }
}
