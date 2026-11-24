export function normalizeXauSymbol(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();

  if (!normalized.startsWith("XAUUSD")) return null;

  const suffix = normalized.slice("XAUUSD".length);
  if (suffix === "") return "XAUUSD";

  if (/^\.[A-Z0-9]{1,12}$/.test(suffix) || /^[-_][A-Z0-9]{1,12}$/.test(suffix)) {
    return "XAUUSD";
  }

  return null;
}

import type { Commodity } from "@/lib/market-schema";

export function findXauCommodity(commodities: Record<string, Commodity>) {
  for (const [key, commodity] of Object.entries(commodities)) {
    if (normalizeXauSymbol(key) === "XAUUSD" && normalizeXauSymbol(commodity.meta.symbol) === "XAUUSD") {
      return commodity;
    }
  }
  return null;
}
