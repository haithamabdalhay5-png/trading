import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSupabaseSessionClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const cookie of cookiesToSet) {
            cookieStore.set(cookie.name, cookie.value, { ...cookie.options, httpOnly: true, sameSite: "lax", secure: true });
          }
        } catch {
          // Server Components cannot always mutate cookies.
        }
      },
    },
  });
}
