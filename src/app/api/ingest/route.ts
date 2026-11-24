import { after, NextResponse } from "next/server";
import { marketPacketSchema } from "@/lib/market-schema";
import { runMonitor } from "@/lib/monitor";
import {
  isAuthorizedBearer,
  isPayloadWithinLimit,
  maxPayloadBytes,
} from "@/lib/market-storage";
import { hasSupabaseConfig, replaceLatestXauSnapshot } from "@/lib/supabase-market-store";
import { findXauCommodity } from "@/lib/xau-symbol";

export async function POST(request: Request) {
  if (!isAuthorizedBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Bearer token is missing or invalid." }, { status: 401 });
  }

  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "STORAGE_NOT_CONFIGURED", message: "Configure Supabase before enabling ingestion." }, { status: 503 });
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxPayloadBytes) {
    return NextResponse.json({ error: "PAYLOAD_TOO_LARGE", maxBytes: maxPayloadBytes }, { status: 413 });
  }

  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxPayloadBytes) {
      await reader.cancel();
      return NextResponse.json({ error: "PAYLOAD_TOO_LARGE", maxBytes: maxPayloadBytes }, { status: 413 });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return NextResponse.json({ error: "INVALID_UTF8" }, { status: 400 });
  }
  if (!isPayloadWithinLimit(raw)) {
    return NextResponse.json({ error: "PAYLOAD_TOO_LARGE", maxBytes: maxPayloadBytes }, { status: 413 });
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const parsed = marketPacketSchema.safeParse(input);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_MARKET_PACKET", issues: parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })) },
      { status: 400 },
    );
  }

  const xau = findXauCommodity(parsed.data.commodities);
  if (!xau) {
    return NextResponse.json({ error: "XAUUSD_NOT_FOUND", message: "The packet does not contain a valid XAUUSD instrument." }, { status: 422 });
  }

  const sourceAt = Date.parse(parsed.data.utc_timestamp);
  const now = Date.now();
  const ageSeconds = Number.isFinite(sourceAt) ? Math.floor((now - sourceAt) / 1_000) : Number.MAX_SAFE_INTEGER;
  if (ageSeconds > 45) {
    return NextResponse.json({ error: "STALE_MARKET_PACKET", message: "MT5 packet timestamp exceeds the 45-second freshness window." }, { status: 422 });
  }
  if (ageSeconds < -30) {
    return NextResponse.json({ error: "FUTURE_MARKET_PACKET", message: "MT5 packet timestamp exceeds the allowed 30-second future skew." }, { status: 422 });
  }
  if (!Number.isFinite(xau.meta.bid) || !Number.isFinite(xau.meta.ask) || xau.meta.ask < xau.meta.bid) {
    return NextResponse.json({ error: "INVALID_XAU_PRICE" }, { status: 422 });
  }
  if (!Number.isInteger(xau.meta.digits) || xau.meta.digits < 0 || !Number.isFinite(xau.meta.contract_specs.tick_size) || xau.meta.contract_specs.tick_size <= 0) {
    return NextResponse.json({ error: "INVALID_XAU_TICK_SPEC" }, { status: 422 });
  }

  const snapshot = { packet: parsed.data, receivedAt: new Date().toISOString(), source: "mt5" as const };
  let previousPacket: typeof parsed.data | null = null;
  try {
    const stored = await replaceLatestXauSnapshot({
      packet: parsed.data,
      symbol: xau.meta.symbol,
      receivedAt: snapshot.receivedAt,
      bid: xau.meta.bid,
      ask: xau.meta.ask,
      spreadPoints: xau.meta.spread_points,
      digits: xau.meta.digits,
      tickSize: xau.meta.contract_specs.tick_size,
      marketSession: xau.meta.market_session,
      marketRegime: xau.quant_regime.detected_regime,
      stale: false,
      mt5Live: true,
    });
    previousPacket = stored.previousPacket as typeof parsed.data | null;
  } catch {
    return NextResponse.json({ error: "LIVE_STORAGE_FAILED", message: "Latest snapshot was not stored." }, { status: 503 });
  }

  // Monitoring compares packets, but no automatic Telegram AI report is sent here.
  after(() =>
    runMonitor(snapshot, previousPacket ? { packet: previousPacket, receivedAt: snapshot.receivedAt, source: "mt5" } : null).catch((error: unknown) => {
      console.error("[monitor] failed:", error instanceof Error ? error.message : "unknown");
    }),
  );

  return NextResponse.json(
    {
      accepted: true,
      received_at: snapshot.receivedAt,
      symbol_count: Object.keys(parsed.data.commodities).length,
      xau_symbol: xau.meta.symbol,
      packet_hash: await import("node:crypto").then(({ createHash }) => createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex")),
    },
    { status: 201 },
  );
}
