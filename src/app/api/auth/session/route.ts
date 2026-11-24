import { NextResponse } from "next/server";
import { createSupabaseSessionClient } from "@/lib/supabase-server";

export async function GET() {
  const client = await createSupabaseSessionClient();
  if (!client) return NextResponse.json({ authenticated: false, configured: false });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return NextResponse.json({ authenticated: false, configured: true });
  return NextResponse.json({ authenticated: true, configured: true, user: { id: data.user.id, email: data.user.email } });
}
