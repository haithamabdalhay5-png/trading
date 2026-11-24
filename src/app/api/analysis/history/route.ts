import { NextResponse } from "next/server";
import { createSupabaseSessionClient } from "@/lib/supabase-server";
import { createSupabaseServerClient } from "@/lib/supabase-market-store";
import { rejectInvalidOrigin, unauthorized } from "@/lib/dashboard-auth";

export async function GET(request: Request) {
  if (rejectInvalidOrigin(request)) return unauthorized();
  const session = await createSupabaseSessionClient();
  if (!session) return unauthorized();
  const { data: userData, error: userError } = await session.auth.getUser();
  if (userError || !userData.user) return unauthorized();

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") ?? "20") || 20));

  const supabase = createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "SUPABASE_NOT_CONFIGURED" }, { status: 503 });

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await supabase
    .from("analysis_runs")
    .select("id,user_id,status,depth,final_decision,final_report,snapshot_timestamp,snapshot_hash,snapshot_age_seconds,started_at,completed_at", { count: "exact" })
    .eq("user_id", userData.user.id)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) return NextResponse.json({ error: "HISTORY_READ_FAILED" }, { status: 500 });
  return NextResponse.json({ page, pageSize, total: count ?? 0, analyses: data ?? [] });
}
