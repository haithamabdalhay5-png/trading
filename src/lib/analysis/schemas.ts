import { z } from "zod";

const evidenceSchema = z.object({
  claims: z.array(z.string().min(1).max(300)).max(12),
  data_points: z.array(z.string().min(1).max(300)).max(20),
  unsupported_claims: z.array(z.string().min(1).max(300)).max(12),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

export const specialistSchema = evidenceSchema.extend({
  assessment: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "UNCERTAIN"]),
  reasons: z.array(z.string().min(1).max(300)).min(1).max(12),
  risks: z.array(z.string().min(1).max(300)).max(12),
});

export const bullBearSchema = z.object({
  thesis: z.string().min(1).max(1000),
  supporting_evidence: z.array(z.string().min(1).max(300)).max(12),
  contradictory_evidence: z.array(z.string().min(1).max(300)).max(12),
  proposed_entry_conditions: z.array(z.string().min(1).max(300)).max(12),
  invalidation_conditions: z.array(z.string().min(1).max(300)).max(12),
  target_liquidity: z.array(z.string().min(1).max(300)).max(12),
  failure_reasons: z.array(z.string().min(1).max(300)).max(12),
});

export const debateSchema = z.object({
  challenges: z.array(z.string().min(1).max(300)).max(16),
  supported_bull_points: z.array(z.string().min(1).max(300)).max(12),
  supported_bear_points: z.array(z.string().min(1).max(300)).max(12),
  unsupported_assumptions: z.array(z.string().min(1).max(16)),
  conclusion: z.enum(["BUY_SUPPORTED", "SELL_SUPPORTED", "MIXED", "NO_TRADE"]),
});

export const finalJudgeSchema = z.object({
  decision: z.enum(["BUY", "SELL", "WAIT", "NO_TRADE"]),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  main_reasoning: z.array(z.string().min(1).max(300)).min(1).max(12),
  risks: z.array(z.string().min(1).max(300)).min(1).max(12),
  invalidation: z.array(z.string().min(1).max(300)).min(1).max(12),
  alternative_scenario: z.string().min(1).max(500),
  evidence_strength: z.enum(["LOW", "MEDIUM", "HIGH"]),
  setup_expiration_seconds: z.number().int().min(30).max(3600),
});

export type SpecialistOutput = z.infer<typeof specialistSchema>;
export type FinalJudgeOutput = z.infer<typeof finalJudgeSchema>;
