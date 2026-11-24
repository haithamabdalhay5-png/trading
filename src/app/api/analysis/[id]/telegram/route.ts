import { NextResponse } from "next/server";
import { createSupabaseSessionClient } from "@/lib/supabase-server";
import { createSupabaseServerClient } from "@/lib/supabase-market-store";
import { rejectInvalidOrigin, unauthorized } from "@/lib/dashboard-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (rejectInvalidOrigin(request)) return unauthorized();
  const session = await createSupabaseSessionClient();
  if (!session) return unauthorized();
  const { data: userData, error: userError } = await session.auth.getUser();
  if (userError || !userData.user) return unauthorized();

  const { id } = await context.params;
  const supabase = createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "SUPABASE_NOT_CONFIGURED" }, { status: 503 });

  const { data: analysis, error } = await supabase
    .from("analysis_runs")
    .select("id,user_id,status,final_decision,final_report,snapshot_timestamp,snapshot_hash")
    .eq("id", id)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: "ANALYSIS_READ_FAILED" }, { status: 500 });
  if (!analysis || analysis.status !== "COMPLETED" || !analysis.final_report) {
    return NextResponse.json({ error: "REPORT_NOT_COMPLETED" }, { status: 409 });
  }

  const { data: existing } = await supabase
    .from("telegram_delivery_records")
    .select("status,telegram_message_id,sent_at")
    .eq("analysis_id", id)
    .maybeSingle();
  if (existing?.status === "SENT") return NextResponse.json({ status: "ALREADY_SENT", telegram_message_id: existing.telegram_message_id, sent_at: existing.sent_at }, { status: 200 });
  if (existing?.status === "QUEUED") return NextResponse.json({ status: "SEND_IN_PROGRESS" }, { status: 202 });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return NextResponse.json({ error: "TELEGRAM_NOT_CONFIGURED" }, { status: 503 });

  const idempotencyKey = `telegram:${id}`;
  const { error: insertError } = await supabase.from("telegram_delivery_records").upsert({
    analysis_id: id,
    status: "QUEUED",
    idempotency_key: idempotencyKey,
  }, { onConflict: "analysis_id" });
  if (insertError) return NextResponse.json({ error: "TELEGRAM_DUPLICATE_LOCK_FAILED" }, { status: 409 });

  const report = analysis.final_report as Record<string, unknown>;
  const escapeHtml = (value: unknown) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const message = [
    "<b>MIRAS AI — XAUUSD</b>",
    `Decision: <b>${escapeHtml(analysis.final_decision)}</b>`,
    `Snapshot: ${escapeHtml(analysis.snapshot_timestamp)} UTC`,
    `Hash: <code>${escapeHtml(analysis.snapshot_hash)}</code>`,
    escapeHtml(report.main_reasoning ?? report),
  ].join("\n");

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 3900), parse_mode: "HTML", disable_web_page_preview: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json() as { ok?: boolean; result?: { message_id?: number }; description?: string };

    if (!response.ok || !payload.ok) {
      await supabase.from("telegram_delivery_records").update({ status: "FAILED", error_code: payload.description ?? "TELEGRAM_SEND_FAILED", updated_at: new Date().toISOString() }).eq("analysis_id", id);
      return NextResponse.json({ status: "FAILED", error: payload.description ?? "TELEGRAM_SEND_FAILED" }, { status: 502 });
    }

    const sentAt = new Date().toISOString();
    await supabase.from("telegram_delivery_records").update({ status: "SENT", telegram_message_id: payload.result?.message_id ?? null, sent_at: sentAt, updated_at: sentAt }).eq("analysis_id", id);
    return NextResponse.json({ status: "SENT", telegram_message_id: payload.result?.message_id ?? null, sent_at: sentAt });
  } catch (error) {
    await supabase.from("telegram_delivery_records").update({ status: "FAILED", error_code: "TELEGRAM_TIMEOUT", updated_at: new Date().toISOString() }).eq("analysis_id", id);
    return NextResponse.json({ status: "FAILED", error: error instanceof Error ? error.message : "TELEGRAM_SEND_FAILED" }, { status: 502 });
  }
}
