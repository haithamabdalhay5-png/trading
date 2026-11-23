import { NextResponse } from "next/server";
import { marketPacketSchema } from "@/lib/market-schema";
import {
  hasUpstashConfig,
  isAuthorizedBearer,
  isPayloadWithinLimit,
  maxPayloadBytes,
  storeHistoricalSnapshot,
  storeLatestSnapshot,
} from "@/lib/market-storage";

export async function POST(request: Request) {
  if (!isAuthorizedBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Bearer token is missing or invalid." }, { status: 401 });
  }

  if (!hasUpstashConfig()) {
    return NextResponse.json({ error: "STORAGE_NOT_CONFIGURED", message: "Configure Upstash Redis before enabling ingestion." }, { status: 503 });
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

  const snapshot = { packet: parsed.data, receivedAt: new Date().toISOString() };
  try {
    await storeLatestSnapshot(snapshot);
  } catch {
    return NextResponse.json({ error: "LIVE_STORAGE_FAILED", message: "Latest snapshot was not stored." }, { status: 503 });
  }

  let history: "saved" | "not_configured" | "failed" = "not_configured";
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      await storeHistoricalSnapshot(snapshot);
      history = "saved";
    } catch {
      history = "failed";
    }
  }

  return NextResponse.json(
    {
      accepted: true,
      received_at: snapshot.receivedAt,
      symbol_count: parsed.data.symbols.length,
      history,
      warning: history === "failed" ? "LIVE_SNAPSHOT_SAVED_HISTORY_WRITE_FAILED" : undefined,
    },
    { status: 201 },
  );
}
