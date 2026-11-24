import { createSupabaseServerClient } from "@/lib/supabase-market-store";

export type StageName =
  | "SNAPSHOT_VALIDATION"
  | "STRUCTURE_SPECIALIST"
  | "VOLUME_SPECIALIST"
  | "LIQUIDITY_SPECIALIST"
  | "MACRO_SPECIALIST"
  | "BULL_ANALYST"
  | "BEAR_ANALYST"
  | "DEBATE"
  | "FINAL_JUDGE"
  | "RISK_VALIDATOR"
  | "REPORT_COMPLETION";

export async function claimStage(input: {
  analysisId: string;
  snapshotHash: string;
  stage: StageName;
  leaseOwner: string;
  leaseSeconds?: number;
}) {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("SUPABASE_NOT_CONFIGURED");

  const leaseUntil = new Date(Date.now() + (input.leaseSeconds ?? 120) * 1_000).toISOString();
  const { data, error } = await client.rpc("claim_analysis_stage", {
    p_analysis_id: input.analysisId,
    p_snapshot_hash: input.snapshotHash,
    p_stage: input.stage,
    p_owner: input.leaseOwner,
    p_lease_until: leaseUntil,
  });

  if (error) throw new Error(`STAGE_CLAIM_FAILED:${error.code}`);
  if (!data) throw new Error("STAGE_NOT_FOUND");
  if (data.status === "COMPLETED") return { alreadyCompleted: true, data };
  if (data.status === "LEASED") return { alreadyCompleted: false, leasedByAnother: true, data };
  return { alreadyCompleted: false, leasedByAnother: false, data };
}

export async function completeStage(input: {
  analysisId: string;
  snapshotHash: string;
  stage: StageName;
  leaseOwner: string;
  result: unknown;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await client
    .from("analysis_stage_results")
    .update({
      status: "COMPLETED",
      result: input.result,
      input_tokens: input.inputTokens ?? 0,
      output_tokens: input.outputTokens ?? 0,
      lease_owner: null,
      lease_until: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("analysis_id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash)
    .eq("stage", input.stage)
    .eq("status", "RUNNING")
    .eq("lease_owner", input.leaseOwner)
    .select("id,status")
    .maybeSingle();

  if (error) throw new Error(`STAGE_SAVE_FAILED:${error.code}`);
  if (!data) throw new Error("STAGE_COMPLETION_LEASE_LOST");
  return data;
}

export async function failStage(input: {
  analysisId: string;
  snapshotHash: string;
  stage: StageName;
  leaseOwner: string;
  providerError: string;
}) {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("SUPABASE_NOT_CONFIGURED");

  await client
    .from("analysis_stage_results")
    .update({
      status: "FAILED",
      provider_error: input.providerError,
      lease_owner: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("analysis_id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash)
    .eq("stage", input.stage)
    .eq("status", "RUNNING")
    .eq("lease_owner", input.leaseOwner);
}
