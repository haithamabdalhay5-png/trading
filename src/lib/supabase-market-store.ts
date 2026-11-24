import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MarketPacket } from "@/lib/market-schema";
import { marketPacketSchema } from "@/lib/market-schema";
import { z } from "zod";

export type LiveXauSnapshot = {
  packet: MarketPacket;
  packet_hash: string;
  source: "mt5";
  received_at: string;
  source_timestamp: string;
  bid: number;
  ask: number;
  spread_points: number;
  digits: number;
  tick_size: number;
  symbol: string;
  market_session: string | null;
  market_regime: string | null;
  stale: boolean;
  mt5_live: boolean;
  updated_at: string;
};

export function hasSupabaseConfig(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createSupabaseServerClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function hashMarketPacket(packet: MarketPacket): string {
  return createHash("sha256").update(JSON.stringify(packet)).digest("hex");
}

export async function readLatestXauSnapshot(): Promise<LiveXauSnapshot | null> {
  const client = createSupabaseServerClient();
  if (!client) return null;

  const { data, error } = await client
    .from("xau_latest_snapshot")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw new Error(`SUPABASE_READ_FAILED:${error.code}`);
  if (!data) return null;
  const rowSchema = z.object({
    packet: marketPacketSchema,
    packet_hash: z.string().length(64),
    source: z.literal("mt5"),
    received_at: z.string(),
    source_timestamp: z.string(),
    bid: z.coerce.number(),
    ask: z.coerce.number(),
    spread_points: z.coerce.number(),
    digits: z.coerce.number(),
    tick_size: z.coerce.number(),
    symbol: z.string(),
    market_session: z.string().nullable(),
    market_regime: z.string().nullable(),
    stale: z.boolean(),
    mt5_live: z.boolean(),
    updated_at: z.string(),
  });
  const parsed = rowSchema.safeParse(data);
  if (!parsed.success) throw new Error("SUPABASE_INVALID_LATEST_SNAPSHOT");
  return parsed.data as LiveXauSnapshot;
}

export async function replaceLatestXauSnapshot(input: {
  packet: MarketPacket;
  symbol: string;
  receivedAt: string;
  bid: number;
  ask: number;
  spreadPoints: number;
  digits: number;
  tickSize: number;
  marketSession: string | null;
  marketRegime: string | null;
  stale: boolean;
  mt5Live: boolean;
}) {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("SUPABASE_NOT_CONFIGURED");

  const packetHash = hashMarketPacket(input.packet);
  const { data, error } = await client.rpc("replace_xau_latest_snapshot", {
    p_packet: input.packet,
    p_packet_hash: packetHash,
    p_received_at: input.receivedAt,
    p_source_timestamp: input.packet.utc_timestamp,
    p_bid: input.bid,
    p_ask: input.ask,
    p_spread_points: input.spreadPoints,
    p_digits: input.digits,
    p_tick_size: input.tickSize,
    p_symbol: input.symbol,
    p_market_session: input.marketSession,
    p_market_regime: input.marketRegime,
    p_stale: input.stale,
    p_mt5_live: input.mt5Live,
  });

  if (error) throw new Error(`SUPABASE_WRITE_FAILED:${error.code}`);
  return { packetHash, previousPacket: data?.previous_packet ?? null };
}
