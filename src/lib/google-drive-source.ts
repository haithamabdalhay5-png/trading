import { marketPacketSchema } from "@/lib/market-schema";
import type { StoredSnapshot } from "@/lib/market-storage";
import { maxPayloadBytes } from "@/lib/market-storage";

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,80}$/;

export function getSharedDriveFileId(): string | null {
  const fileId = process.env.GOOGLE_DRIVE_FILE_ID?.trim();
  return fileId && FILE_ID_PATTERN.test(fileId) ? fileId : null;
}

export async function fetchSharedDriveSnapshot(fileId: string): Promise<StoredSnapshot> {
  if (!FILE_ID_PATTERN.test(fileId)) throw new Error("INVALID_DRIVE_FILE_ID");

  const url = new URL("https://drive.google.com/uc");
  url.searchParams.set("export", "download");
  url.searchParams.set("id", fileId);

  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`DRIVE_HTTP_${response.status}`);

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxPayloadBytes) throw new Error("DRIVE_FILE_TOO_LARGE");

  const reader = response.body?.getReader();
  if (!reader) throw new Error("DRIVE_EMPTY_RESPONSE");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxPayloadBytes) {
      await reader.cancel();
      throw new Error("DRIVE_FILE_TOO_LARGE");
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
    throw new Error("DRIVE_FILE_INVALID_UTF8");
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("DRIVE_FILE_INVALID_JSON");
  }

  const parsed = marketPacketSchema.safeParse(input);
  if (!parsed.success) throw new Error("DRIVE_FILE_SCHEMA_MISMATCH");

  return { packet: parsed.data, receivedAt: new Date().toISOString(), source: "drive" };
}
