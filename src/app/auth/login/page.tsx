"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setError("");
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setError("Authentication is not configured.");
      setLoading(false);
      return;
    }
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    router.replace("/");
  }

  return (
    <main className="app-shell login-shell" dir="rtl">
      <section className="login-panel">
        <p className="eyebrow">MIRAS AI</p>
        <h1>تسجيل الدخول</h1>
        <label>البريد الإلكتروني<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>كلمة المرور<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <p className="notice notice-error">{error}</p>}
        <button className="reco-button login-button" onClick={() => void submit()} disabled={loading || !email || !password}>{loading ? "جارٍ الدخول..." : "دخول"}</button>
      </section>
    </main>
  );
}
