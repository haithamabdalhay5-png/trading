import { Client } from "@upstash/qstash";
import { createSupabaseServerClient } from "@/lib/supabase-market-store";
import type { StageName } from "@/lib/analysis/stage-engine";

export function getQstashClient() {
  if (!process.env.QSTASH_TOKEN) return null;
  return new Client({ token: process.env.QSTASH_TOKEN });
}

export async function reserveDailyBudget(input: { depth: "STANDARD" | "DEEP" }) {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("SUPABASE_NOT_CONFIGURED");

  const day = new Date().toISOString().slice(0, 10);
  const reserved = input.depth === "STANDARD" ? 10 : 16;
  const { data, error } = await client.rpc("reserve_miras_analysis_budget", {
    p_day: day,
    p_depth: input.depth,
    p_reserved: reserved,
  });
  if (error) throw new Error(`DAILY_BUDGET_FAILED:${error.code}`);
  if (data !== true) throw new Error("DAILY_QSTASH_BUDGET_EXHAUSTED");
  return { day, reserved };
}

export async function addOutboxStage(input: {
  analysisId: string;
  snapshotHash: string;
  stage: StageName;
  payload: Record<string, unknown>;
}) {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("SUPABASE_NOT_CONFIGURED");

  const destination = `${process.env.APP_URL?.replace(/\/+$/, "") ?? ""}/api/analysis/${input.analysisId}/stage`;
  const deduplicationId = `miras:${input.analysisId}:${input.snapshotHash}:${input.stage}`;

  const { error } = await client.from("qstash_outbox").upsert({
    analysis_id: input.analysisId,
    snapshot_hash: input.snapshotHash,
    stage: input.stage,
    destination,
    payload: input.payload,
    deduplication_id: deduplicationId,
    published: false,
  }, { onConflict: "analysis_id,snapshot_hash,stage" });

  if (error) throw new Error(`OUTBOX_INSERT_FAILED:${error.code}`);
  return { destination, deduplicationId };
}

export async function publishOutboxStage(input: {
  analysisId: string;
  snapshotHash: string;
  stage: StageName;
}) {
  const client = createSupabaseServerClient();
  const qstash = getQstashClient();
  if (!client || !qstash) throw new Error("JOBS_NOT_CONFIGURED");

  const { data, error } = await client
    .from("qstash_outbox")
    .select("destination,payload,deduplication_id,published")
    .eq("analysis_id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash)
    .eq("stage", input.stage)
    .maybeSingle();

  if (error) throw new Error(`OUTBOX_READ_FAILED:${error.code}`);
  if (!data) throw new Error("OUTBOX_MESSAGE_NOT_FOUND");
  if (data.published) return { alreadyPublished: true };

  const response = await qstash.publishJSON({
    url: data.destination,
    body: data.payload,
    deduplicationId: data.deduplication_id,
    retries: 1,
  });

  if (!response.messageId) throw new Error("QSTASH_PUBLISH_FAILED");

  const { error: updateError } = await client
    .from("qstash_outbox")
    .update({ published: true, published_at: new Date().toISOString(), attempt_count: 1, updated_at: new Date().toISOString() })
    .eq("analysis_id", input.analysisId)
    .eq("snapshot_hash", input.snapshotHash)
    .eq("stage", input.stage);

  if (updateError) throw new Error(`OUTBOX_MARK_PUBLISHED_FAILED:${updateError.code}`);
  return { alreadyPublished: false, messageId: response.messageId };
}
