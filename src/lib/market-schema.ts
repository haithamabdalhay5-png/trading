import { z } from "zod";

const finiteNumber = z.number().finite();

/**
 * Canonical envelope for MT5 Exporter 12.3 / Schema 2.1.
 * Per-instrument fields are intentionally passthrough until the real exporter
 * sample is supplied; required control fields remain validated here.
 */
export const marketPacketSchema = z
  .object({
    schema_version: z.union([z.string(), z.number()]).optional(),
    exporter_version: z.string().optional(),
    utc_timestamp: z.string().datetime({ offset: true }),
    server_utc_offset_minutes: finiteNumber.optional(),
    active_session: z.string().optional(),
    killzone_active: z.boolean().optional(),
    symbols: z
      .array(
        z
          .object({
            symbol: z.string().trim().min(1).max(32),
            bid: finiteNumber.optional(),
            ask: finiteNumber.optional(),
            spread_points: finiteNumber.optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(32),
  })
  .passthrough()
  .superRefine((packet, context) => {
    const seen = new Set<string>();
    packet.symbols.forEach((instrument, index) => {
      const normalized = instrument.symbol.toUpperCase();
      if (seen.has(normalized)) {
        context.addIssue({
          code: "custom",
          path: ["symbols", index, "symbol"],
          message: `Duplicate symbol: ${instrument.symbol}`,
        });
      }
      seen.add(normalized);
      if (instrument.bid !== undefined && instrument.ask !== undefined && instrument.ask < instrument.bid) {
        context.addIssue({
          code: "custom",
          path: ["symbols", index, "ask"],
          message: "Ask must be greater than or equal to bid",
        });
      }
    });
  });

export type MarketPacket = z.infer<typeof marketPacketSchema>;
