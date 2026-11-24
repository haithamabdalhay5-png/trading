import { NextResponse } from "next/server";
import { createSupabaseSessionClient } from "@/lib/supabase-server";
import { createSupabaseServerClient } from "@/lib/supabase-market-store";
import { rejectInvalidOrigin, unauthorized } from "@/lib/dashboard-auth";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (rejectInvalidOrigin(request)) return unauthorized();
  const session = await createSupabaseSessionClient();
  if (!session) return unauthorized();
  const { data: userData, error: userError } = await session.auth.getUser();
  if (userError || !userData.user) return unauthorized();

  const { id } = await context.params;
  const supabase = createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "SUPABASE_NOT_CONFIGURED" }, { status: 503 });

  const { data, error } = await supabase
    .from("analysis_runs")
    .select("id,user_id,status,depth,final_decision,final_report,snapshot_timestamp,snapshot_hash,snapshot_age_seconds,current_stage,started_at,completed_at,error_code,error_message")
    .eq("id", id)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: "ANALYSIS_READ_FAILED" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "ANALYSIS_NOT_FOUND" }, { status: 404 });

  const { data: stages } = await supabase
    .from("analysis_stage_results")
    .select("stage,status,result,provider_error,attempt_count,started_at,completed_at")
    .eq("analysis_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ analysis: data, stages: stages ?? [] });
}
