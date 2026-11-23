import { timingSafeEqual } from "node:crypto";
import type { MarketPacket } from "@/lib/market-schema";

const LATEST_KEY = "market:latest";
const DRIVE_CACHE_KEY = "market:drive:latest";
const DRIVE_REFRESH_KEY = "market:drive:refresh-lock";
const DRIVE_CACHE_TTL_SECONDS = "600";
const DRIVE_REFRESH_COOLDOWN_SECONDS = "50";
const MAX_PAYLOAD_BYTES = 256 * 1024;

export type StoredSnapshot = {
  packet: MarketPacket;
  receivedAt: string;
  source?: "mt5" | "drive";
};

export function isPayloadWithinLimit(raw: string): boolean {
  return Buffer.byteLength(raw, "utf8") <= MAX_PAYLOAD_BYTES;
}

export function isAuthorizedBearer(header: string | null, envName = "MT5_INGEST_TOKEN"): boolean {
  const expected = process.env[envName];
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function hasUpstashConfig(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export function hasSupabaseConfig(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function upstashCommand<T>(command: "GET" | "SET" | "DEL", ...args: string[]): Promise<T> {
  const baseUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!baseUrl || !token) throw new Error("UPSTASH_NOT_CONFIGURED");

  const response = await fetch(baseUrl.replace(/\/+$/, ""), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([command, ...args]),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`UPSTASH_HTTP_${response.status}`);
  const body = (await response.json()) as { result?: T; error?: string };
  if (body.error) throw new Error(`UPSTASH_COMMAND_ERROR: ${body.error}`);
  return body.result as T;
}

/**
 * Stores the newest snapshot and returns the previous one in a single Redis command
 * (SET ... GET), so the alert monitor can compare packets without extra reads.
 */
export async function storeLatestSnapshot(snapshot: StoredSnapshot): Promise<StoredSnapshot | null> {
  const previous = await upstashCommand<string | null>("SET", LATEST_KEY, JSON.stringify(snapshot), "GET");
  if (!previous) return null;
  try {
    return JSON.parse(previous) as StoredSnapshot;
  } catch {
    return null;
  }
}

/** SET NX EX: true only for the first caller within the window (cooldowns, once-per-outage alerts). */
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const result = await upstashCommand<string | null>("SET", key, "1", "EX", String(ttlSeconds), "NX");
  return result === "OK";
}

/** Returns true when the key existed and was removed. */
export async function releaseLock(key: string): Promise<boolean> {
  return (await upstashCommand<number>("DEL", key)) > 0;
}

export async function readLatestSnapshot(): Promise<StoredSnapshot | null> {
  return readSnapshotAt(LATEST_KEY);
}

export async function storeDriveFallbackSnapshot(snapshot: StoredSnapshot): Promise<void> {
  // Retain the last valid result for outage visibility; freshness is checked from packet.utc_timestamp.
  await upstashCommand<string>("SET", DRIVE_CACHE_KEY, JSON.stringify(snapshot), "EX", DRIVE_CACHE_TTL_SECONDS);
}

export async function readDriveFallbackSnapshot(): Promise<StoredSnapshot | null> {
  return readSnapshotAt(DRIVE_CACHE_KEY);
}

export async function tryAcquireDriveRefresh(): Promise<boolean> {
  const result = await upstashCommand<string | null>(
    "SET", DRIVE_REFRESH_KEY, "1", "EX", DRIVE_REFRESH_COOLDOWN_SECONDS, "NX",
  );
  return result === "OK";
}

async function readSnapshotAt(key: string): Promise<StoredSnapshot | null> {
  const value = await upstashCommand<string | null>("GET", key);
  if (!value) return null;
  try {
    return JSON.parse(value) as StoredSnapshot;
  } catch {
    throw new Error("UPSTASH_INVALID_SNAPSHOT");
  }
}

export const maxPayloadBytes = MAX_PAYLOAD_BYTES;
