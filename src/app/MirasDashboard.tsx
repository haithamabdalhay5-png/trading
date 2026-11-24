"use client";

import { useCallback, useEffect, useState } from "react";

type MarketStatus = {
  xau: null | { symbol: string; bid: number; ask: number; spread_points: number; digits: number; tick_size: number; market_session: string | null; market_regime: string | null; packet_timestamp: string };
  mt5_live: boolean;
  stale: boolean;
  age_seconds?: number;
  recommendations_locked: boolean;
  health: { mt5: string; drive: string; redis: string; supabase: string };
};

type AuthStatus = { authenticated: boolean; configured: boolean };
type AnalysisRun = { analysisId: string; status: string; depth: string; snapshot_hash: string };

function price(value: number | undefined, digits = 2) { return typeof value === "number" ? value.toFixed(digits) : "—"; }
function time(value?: string) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").slice(0, 19) + " UTC"; }

export default function MirasDashboard() {
  const [market, setMarket] = useState<MarketStatus | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRun | null>(null);
  const [detail, setDetail] = useState<{ analysis?: { status?: string; final_decision?: string; final_report?: Record<string, unknown> }; stages?: Array<{ stage: string; status: string }> } | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; status: string; depth: string; final_decision?: string; started_at?: string }>>([]);
  const [message, setMessage] = useState("");

  const refreshMarket = useCallback(async () => {
    try { const response = await fetch("/api/market/latest", { cache: "no-store" }); setMarket(await response.json() as MarketStatus); } catch { setMarket(null); }
  }, []);
  const refreshAuth = useCallback(async () => {
    try { const response = await fetch("/api/auth/session", { cache: "no-store" }); setAuth(await response.json() as AuthStatus); } catch { setAuth({ authenticated: false, configured: false }); }
  }, []);
  const refreshHistory = useCallback(async () => {
    try { const response = await fetch("/api/analysis/history?page=1&pageSize=20", { cache: "no-store" }); if (response.ok) { const payload = await response.json() as { analyses?: typeof history }; setHistory(payload.analyses ?? []); } } catch { setHistory([]); }
  }, []);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      await Promise.all([refreshMarket(), refreshAuth()]);
    };
    void initialize();
    const timer = window.setInterval(() => {
      if (active && !document.hidden) void refreshMarket();
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshMarket, refreshAuth]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const initializeHistory = async () => {
      await refreshHistory();
    };
    void initializeHistory();
  }, [auth?.authenticated, refreshHistory]);
  useEffect(() => {
    if (!analysis?.analysisId) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/analysis/${analysis.analysisId}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as typeof detail;
        if (!active) return;
        setDetail(payload);
        const status = payload?.analysis?.status;
        if (status === "COMPLETED" || status === "FAILED" || status === "REJECTED") {
          window.clearInterval(timer);
          setAnalysis((current) => current ? { ...current, status } : current);
          void refreshHistory();
        }
      } catch { /* polling continues */ }
    }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [analysis?.analysisId, refreshHistory]);

  async function startAnalysis() {
    setMessage("");
    try {
      const response = await fetch("/api/analysis", { method: "POST", headers: { "Content-Type": "application/json", "idempotency-key": crypto.randomUUID() }, body: "{}" });
      const payload = await response.json();
      if (!response.ok) { setMessage(payload.message ?? payload.error ?? "تعذر بدء التحليل"); return; }
      setAnalysis({ analysisId: payload.analysisId, status: payload.status, depth: payload.depth, snapshot_hash: payload.snapshot_hash });
    } catch { setMessage("تعذر الاتصال بخادم التحليل."); }
  }

  async function sendTelegram() {
    if (!analysis?.analysisId) return;
    const response = await fetch(`/api/analysis/${analysis.analysisId}/telegram`, { method: "POST" });
    const payload = await response.json();
    setMessage(response.ok ? "تم إرسال التقرير إلى Telegram." : (payload.error ?? "تعذر إرسال التقرير."));
  }

  const xau = market?.xau;
  const completed = detail?.analysis;
  const report = completed?.final_report;
  const canAnalyze = auth?.authenticated && market?.mt5_live === true && market?.stale !== true && market?.recommendations_locked === false;

  return (
    <main className="app-shell miras-shell" dir="rtl">
      <header className="topbar">
        <a className="brand" href="#overview"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span><b>MIRAS AI</b><small>XAUUSD INTELLIGENCE</small></span></a>
        <div className="topbar-meta"><span className={`conn-chip ${market?.mt5_live ? "online" : "offline"}`}><i />{market?.mt5_live ? "MT5 مباشر" : "MT5 غير متصل"}</span>{auth?.authenticated ? <span className="environment-tag">حساب موثّق</span> : <a className="environment-tag" href="/auth/login">تسجيل الدخول</a>}</div>
      </header>
      <section className="health-ribbon" aria-label="صحة النظام">
        {[["جسر MT5", market?.health.mt5 ?? "unknown"],["نسخة Drive", market?.health.drive ?? "unknown"],["Redis", market?.health.redis ?? "unknown"],["Supabase", market?.health.supabase ?? "unknown"]].map(([label, status]) => <div className="health-pill" key={label}><span className="health-dot bad" /><span className="health-label">{label}</span><strong className="health-value">{status}</strong></div>)}
      </section>
      <div className="content" id="overview">
        <section className="page-heading"><div><p className="eyebrow">MIRAS AI · تحليل XAUUSD يدوي</p><h1>صورة السوق</h1><p className="subheading">تحليل بحثي فقط؛ لا توجد أوامر تنفيذ صفقات.</p></div><div className="heading-actions"><button className="reco-button" onClick={() => void startAnalysis()} disabled={!canAnalyze || Boolean(analysis && !["COMPLETED","FAILED","REJECTED"].includes(analysis.status))}>◈ تحليل XAUUSD</button><button className="refresh-button" onClick={() => void refreshMarket()}>↻ تحديث</button></div></section>
        {message && <div className="notice notice-warn" role="status">{message}</div>}
        <section className="summary-grid"><article className="summary-card"><span className="card-label">Bid / Ask</span><strong className="summary-value ltr-number">{price(xau?.bid, xau?.digits)} / {price(xau?.ask, xau?.digits)}</strong><small>{xau?.symbol ?? "لا توجد لقطة مباشرة"}</small></article><article className="summary-card"><span className="card-label">السبريد</span><strong className="summary-value ltr-number">{xau ? xau.spread_points : "—"} نقطة</strong><small>حد XAUUSD: 35 نقطة</small></article><article className="summary-card"><span className="card-label">آخر تحديث</span><strong className="summary-value ltr-number">{time(xau?.packet_timestamp)}</strong><small>{market?.age_seconds !== undefined ? `عمر الحزمة: ${market.age_seconds} ثانية` : "لا يوجد timestamp"}</small></article></section>
        {auth?.authenticated === false && <div className="notice notice-warn">يجب تسجيل الدخول لبدء التحليل أو إرسال التقرير.</div>}
        {analysis && <section className="panel"><div className="panel-heading"><div><p className="eyebrow">تحليل مباشر</p><h2>{analysis.analysisId.slice(0, 8)} · {analysis.depth}</h2></div><span className="live-label live"><i />{completed?.status ?? analysis.status}</span></div><div className="analysis-steps"><span>Snapshot validation</span><span>Structure</span><span>Volume</span><span>Liquidity</span><span>Macro</span><span>Judge</span><span>Risk</span></div></section>}
        {completed?.status === "COMPLETED" && report && <section className="panel decision-panel"><div className="panel-heading"><div><p className="eyebrow">التقرير النهائي</p><h2>{completed.final_decision ?? "NO_TRADE"}</h2></div><button className="reco-button" onClick={() => void sendTelegram()}>إرسال إلى Telegram</button></div><div className="report-grid"><article><span>السوق</span><strong>{String(report.market_regime ?? xau?.market_regime ?? "غير محدد")}</strong></article><article><span>ثقة الدليل</span><strong>{String(report.evidence_strength ?? "LOW")}</strong></article><article><span>المنطق الرئيسي</span><strong>{Array.isArray(report.main_reasoning) ? report.main_reasoning.join(" · ") : String(report.main_reasoning ?? "")}</strong></article></div></section>}
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">تغذية البيانات</p><h2>XAUUSD</h2></div><span className="live-label live"><i />{xau ? "لقطة مباشرة" : "لا توجد لقطة"}</span></div>{xau ? <div className="table-wrap"><table><thead><tr><th>الأداة</th><th>Bid</th><th>Ask</th><th>السبريد</th><th>الجلسة</th></tr></thead><tbody><tr><td><span className="symbol-badge">{xau.symbol}</span></td><td className="ltr-number">{price(xau.bid, xau.digits)}</td><td className="ltr-number">{price(xau.ask, xau.digits)}</td><td className="ltr-number">{xau.spread_points}</td><td>{xau.market_session ?? "غير متوفر"}</td></tr></tbody></table></div> : <div className="empty-state"><h3>لا توجد لقطة مباشرة</h3><p>يتم قبول حزم MT5 فقط للتحليل؛ نسخة Drive للمراقبة ولا تفتح توصيات.</p></div>}</section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">السجل</p><h2>التحليلات السابقة</h2></div></div>{history.length ? <div className="history-list">{history.map((item) => <button className="history-row" key={item.id} onClick={() => setAnalysis({ analysisId: item.id, status: item.status, depth: item.depth, snapshot_hash: "" })}><b>{item.final_decision ?? item.status}</b><span>{item.depth}</span><span>{time(item.started_at)}</span></button>)}</div> : <div className="empty-state"><p>لا توجد تحليلات محفوظة بعد.</p></div>}</section>
        <footer className="footer-note"><span>MIRAS AI · XAUUSD فقط · لا تنفيذ صفقات</span><span>Gemini Free Tier may use submitted content for product improvement.</span></footer>
      </div>
    </main>
  );
}
