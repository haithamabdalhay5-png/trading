export type EntryProposal = {
  verdict: "BUY" | "SELL" | "WAIT" | "NO_TRADE";
  entry_low?: number;
  entry_high?: number;
  stop_loss?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
};

export type EntryValidation = {
  valid: boolean;
  reasons: string[];
};

function align(value: number, tickSize: number): number {
  const aligned = Math.round(value / tickSize) * tickSize;
  const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)));
  return Number(aligned.toFixed(decimals));
}

export function validateEntryProposal(input: {
  proposal: EntryProposal;
  bid: number;
  ask: number;
  spreadPoints: number;
  spreadLimit: number;
  atrM5: number;
  digits: number;
  tickSize: number;
  maxEntryDistanceAtrMultiple?: number;
}): EntryValidation {
  const { proposal, bid, ask, spreadPoints, spreadLimit, atrM5, digits, tickSize } = input;
  const reasons: string[] = [];

  if (proposal.verdict === "WAIT" || proposal.verdict === "NO_TRADE") {
    return { valid: true, reasons: [] };
  }
  if (spreadPoints > spreadLimit) reasons.push("SPREAD_VETO");
  if (!Number.isFinite(atrM5) || atrM5 <= 0) reasons.push("INVALID_ATR");
  if (!proposal.entry_low || !proposal.entry_high || !proposal.stop_loss || !proposal.tp1) {
    reasons.push("INCOMPLETE_ACTIONABLE_LEVELS");
  }

  if (reasons.length === 0 && proposal.entry_low && proposal.entry_high && proposal.stop_loss && proposal.tp1) {
    const entryMid = (proposal.entry_low + proposal.entry_high) / 2;
    const maxDistance = atrM5 * (input.maxEntryDistanceAtrMultiple ?? 0.25);

    if (proposal.verdict === "BUY") {
      if (proposal.entry_low < ask) reasons.push("BUY_ENTRY_BELOW_ASK");
      if (proposal.stop_loss >= proposal.entry_low) reasons.push("INVALID_BUY_STOP_LOSS");
      if (proposal.tp1 <= proposal.entry_high) reasons.push("INVALID_BUY_TP1");
      if (entryMid - ask > maxDistance) reasons.push("BUY_ENTRY_TOO_FAR");
    } else {
      if (proposal.entry_high > bid) reasons.push("SELL_ENTRY_ABOVE_BID");
      if (proposal.stop_loss <= proposal.entry_high) reasons.push("INVALID_SELL_STOP_LOSS");
      if (proposal.tp1 >= proposal.entry_low) reasons.push("INVALID_SELL_TP1");
      if (bid - entryMid > maxDistance) reasons.push("SELL_ENTRY_TOO_FAR");
    }

    if (proposal.tp2 !== undefined && proposal.tp3 !== undefined) {
      if (proposal.verdict === "BUY" && !(proposal.tp1 < proposal.tp2 && proposal.tp2 < proposal.tp3)) reasons.push("INVALID_BUY_TP_ORDER");
      if (proposal.verdict === "SELL" && !(proposal.tp1 > proposal.tp2 && proposal.tp2 > proposal.tp3)) reasons.push("INVALID_SELL_TP_ORDER");
    } else if (proposal.tp2 !== undefined) {
      if (proposal.verdict === "BUY" && proposal.tp2 <= proposal.tp1) reasons.push("INVALID_BUY_TP_ORDER");
      if (proposal.verdict === "SELL" && proposal.tp2 >= proposal.tp1) reasons.push("INVALID_SELL_TP_ORDER");
    }

    for (const [name, value] of Object.entries({ entry_low: proposal.entry_low, entry_high: proposal.entry_high, stop_loss: proposal.stop_loss, tp1: proposal.tp1, tp2: proposal.tp2, tp3: proposal.tp3 })) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value <= 0) reasons.push(`INVALID_${name.toUpperCase()}`);
      const expected = align(value, tickSize);
      if (value !== expected) reasons.push(`${name.toUpperCase()}_NOT_ALIGNED_TO_TICK`);
      if (Number(value.toFixed(digits)) !== value) reasons.push(`${name.toUpperCase()}_INVALID_DIGITS`);
    }

    const risk = proposal.verdict === "BUY"
      ? proposal.entry_low - proposal.stop_loss
      : proposal.stop_loss - proposal.entry_high;
    const reward = proposal.verdict === "BUY"
      ? proposal.tp1 - proposal.entry_high
      : proposal.entry_low - proposal.tp1;
    if (risk <= 0 || reward <= 0 || reward / risk < 1) reasons.push("INVALID_RISK_REWARD");
  }

  return { valid: reasons.length === 0, reasons };
}
