import { timingSafeEqual } from "node:crypto";
import type { MarketPacket } from "@/lib/market-schema";

const LATEST_KEY = "market:latest";
const MAX_PAYLOAD_BYTES = 256 * 1024;

export type StoredSnapshot = {
  packet: MarketPacket;
  receivedAt: string;
};

export function isPayloadWithinLimit(raw: string): boolean {
  return Buffer.byteLength(raw, "utf8") <= MAX_PAYLOAD_BYTES;
}

export function isAuthorizedBearer(header: string | null): boolean {
  const expected = process.env.MT5_INGEST_TOKEN;
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

async function upstashCommand<T>(command: "GET" | "SET", ...args: string[]): Promise<T> {
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

export async function storeLatestSnapshot(snapshot: StoredSnapshot): Promise<void> {
  await upstashCommand<string>("SET", LATEST_KEY, JSON.stringify(snapshot));
}

export async function readLatestSnapshot(): Promise<StoredSnapshot | null> {
  const value = await upstashCommand<string | null>("GET", LATEST_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as StoredSnapshot;
  } catch {
    throw new Error("UPSTASH_INVALID_SNAPSHOT");
  }
}

export async function storeHistoricalSnapshot(snapshot: StoredSnapshot): Promise<void> {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey) throw new Error("SUPABASE_NOT_CONFIGURED");

  const response = await fetch(`${baseUrl}/rest/v1/market_snapshots`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      received_at: snapshot.receivedAt,
      source_timestamp: snapshot.packet.utc_timestamp,
      schema_version: String(snapshot.packet.schema_version ?? "2.1"),
      symbol_count: Object.keys(snapshot.packet.commodities).length,
      payload: snapshot.packet,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_HTTP_${response.status}`);
}

export const maxPayloadBytes = MAX_PAYLOAD_BYTES;
