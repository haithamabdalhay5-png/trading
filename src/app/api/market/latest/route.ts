import { NextResponse } from "next/server";
import {
  hasSupabaseConfig,
  hasUpstashConfig,
  readDriveFallbackSnapshot,
  readLatestSnapshot,
  storeDriveFallbackSnapshot,
  tryAcquireDriveRefresh,
  type StoredSnapshot,
} from "@/lib/market-storage";
import { fetchSharedDriveSnapshot, getSharedDriveFileId } from "@/lib/google-drive-source";
import {
  DRIVE_MAX_AGE_SECONDS,
  FUTURE_CLOCK_SKEW_SECONDS,
  MT5_LIVE_MAX_AGE_SECONDS,
} from "@/lib/risk-config";

const DRIVE_REFRESH_AGE_SECONDS = 45;

type SnapshotAge = { receivedAge: number; sourceAge: number; fresh: boolean };

function getAge(snapshot: StoredSnapshot): SnapshotAge {
  const now = Date.now();
  const receivedAt = Date.parse(snapshot.receivedAt);
  const sourceAt = Date.parse(snapshot.packet.utc_timestamp);
  const receivedAge = Number.isFinite(receivedAt) ? Math.max(0, Math.floor((now - receivedAt) / 1_000)) : Number.MAX_SAFE_INTEGER;
  const sourceAge = Number.isFinite(sourceAt) ? Math.floor((now - sourceAt) / 1_000) : Number.MAX_SAFE_INTEGER;
  // Live MT5 data goes offline after 45s; the Drive backup keeps its own, looser limit.
  const maxAge = snapshot.source === "drive" ? DRIVE_MAX_AGE_SECONDS : MT5_LIVE_MAX_AGE_SECONDS;
  return {
    receivedAge,
    sourceAge,
    fresh: sourceAge <= maxAge && sourceAge >= -FUTURE_CLOCK_SKEW_SECONDS,
  };
}

function isMt5Live(snapshot: StoredSnapshot | null): boolean {
  if (!snapshot || snapshot.source === "drive") return false;
  const age = getAge(snapshot);
  return age.fresh && age.receivedAge <= MT5_LIVE_MAX_AGE_SECONDS;
}

function responseFor(snapshot: StoredSnapshot | null, statuses: { mt5: string; drive: string; redis: string }, error?: string) {
  const age = snapshot ? getAge(snapshot) : null;
  const mt5Live = isMt5Live(snapshot);
  return NextResponse.json({
    snapshot,
    age_seconds: age?.receivedAge,
    source_age_seconds: age?.sourceAge,
    stale: snapshot ? !age?.fresh : false,
    // Recommendations may only run on a live MT5 feed, never on the Drive backup or stale data.
    mt5_live: mt5Live,
    recommendations_locked: !mt5Live,
    ...(mt5Live ? {} : { error_code: "ERR_MT5_OFFLINE" }),
    health: {
      ...statuses,
      supabase: hasSupabaseConfig() ? "configured" : "not_configured",
    },
    ...(error ? { error } : {}),
  });
}

export async function GET(request: Request) {
  // Request access keeps Cache Components from prerendering a live-data response at build time.
  void request.headers.get("x-request-id");
  const baseHealth = {
    mt5: "waiting",
    drive: getSharedDriveFileId() ? "waiting" : "not_configured",
    redis: hasUpstashConfig() ? "connected" : "not_configured",
  };

  if (!hasUpstashConfig()) return responseFor(null, baseHealth);

  try {
    const [direct, cachedDrive] = await Promise.all([readLatestSnapshot(), readDriveFallbackSnapshot()]);
    if (direct && isMt5Live(direct)) {
      return responseFor(direct, { ...baseHealth, mt5: "connected", drive: cachedDrive ? "configured" : baseHealth.drive });
    }

    const fileId = getSharedDriveFileId();
    let driveSnapshot = cachedDrive;
    let driveHealth = fileId ? (cachedDrive ? "connected" : "waiting") : "not_configured";
    let driveFailure = false;
    const cachedAge = cachedDrive ? getAge(cachedDrive) : null;

    const shouldRefresh = Boolean(
      fileId && (!cachedDrive || !cachedAge || cachedAge.receivedAge >= DRIVE_REFRESH_AGE_SECONDS),
    );
    if (fileId && shouldRefresh && await tryAcquireDriveRefresh()) {
      try {
        const freshSnapshot = await fetchSharedDriveSnapshot(fileId);
        await storeDriveFallbackSnapshot(freshSnapshot);
        driveSnapshot = freshSnapshot;
        driveHealth = "connected";
      } catch {
        driveFailure = true;
        driveHealth = cachedDrive ? "offline" : "error";
      }
    }

    const driveAge = driveSnapshot ? getAge(driveSnapshot) : null;
    const driveIsFresh = Boolean(driveSnapshot && driveAge?.fresh);
    if (driveSnapshot && driveIsFresh) {
      return responseFor(driveSnapshot, {
        ...baseHealth,
        mt5: direct ? "offline" : "waiting",
        drive: driveHealth,
      });
    }

    // Preserve a previous packet for visibility only; stale=true tells consumers not to act on it.
    const candidates = [direct, driveSnapshot].filter((item): item is StoredSnapshot => Boolean(item));
    candidates.sort((a, b) => Date.parse(b.packet.utc_timestamp) - Date.parse(a.packet.utc_timestamp));
    const selected = candidates[0] ?? null;
    return responseFor(selected, {
      ...baseHealth,
      mt5: direct ? "offline" : "waiting",
      drive: driveHealth,
    }, driveFailure && !selected ? "DRIVE_SOURCE_UNAVAILABLE" : undefined);
  } catch {
    return NextResponse.json({
      snapshot: null,
      mt5_live: false,
      recommendations_locked: true,
      error_code: "ERR_MT5_OFFLINE",
      health: { ...baseHealth, mt5: "unknown", drive: "unknown", redis: "error", supabase: hasSupabaseConfig() ? "configured" : "not_configured" },
      error: "LIVE_STORAGE_UNAVAILABLE",
    }, { status: 503 });
  }
}
