import { NextResponse } from "next/server";
import { hasUpstashConfig, isAuthorizedBearer, readLatestSnapshot } from "@/lib/market-storage";
import { checkFeedHealth } from "@/lib/monitor";
import { hasTelegramConfig } from "@/lib/telegram";

/**
 * Called every minute by an external pinger (for example cron-job.org) with
 * `Authorization: Bearer <MONITOR_HEARTBEAT_TOKEN>`. Needed because an outage means no ingest
 * requests arrive at all, so nothing inside the ingest route can notice it.
 */
export async function GET(request: Request) {
  if (!isAuthorizedBearer(request.headers.get("authorization"), "MONITOR_HEARTBEAT_TOKEN")) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!hasUpstashConfig() || !hasTelegramConfig()) {
    return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503 });
  }
  try {
    const status = await checkFeedHealth(await readLatestSnapshot());
    return NextResponse.json({ status });
  } catch {
    return NextResponse.json({ error: "HEARTBEAT_FAILED" }, { status: 503 });
  }
}
