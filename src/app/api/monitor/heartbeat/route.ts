import { NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/market-storage";
import { hasSupabaseConfig, readLatestXauSnapshot } from "@/lib/supabase-market-store";

/**
 * Called every minute by an external pinger (for example cron-job.org) with
 * `Authorization: Bearer <MONITOR_HEARTBEAT_TOKEN>`. Needed because an outage means no ingest
 * requests arrive at all, so nothing inside the ingest route can notice it.
 */
export async function GET(request: Request) {
  if (!isAuthorizedBearer(request.headers.get("authorization"), "MONITOR_HEARTBEAT_TOKEN")) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503 });
  }
  try {
    const live = await readLatestXauSnapshot();
    if (!live) return NextResponse.json({ status: "no_data" });
    const ageSeconds = Math.floor((Date.now() - Date.parse(live.source_timestamp)) / 1_000);
    const status = ageSeconds <= 45 ? "ok" : "offline_already_alerted";
    return NextResponse.json({ status, age_seconds: Math.max(0, ageSeconds) });
  } catch {
    return NextResponse.json({ error: "HEARTBEAT_FAILED" }, { status: 503 });
  }
}
