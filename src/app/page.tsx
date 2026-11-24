"use client";

import { useCallback, useEffect, useState } from "react";
import { MT5_LIVE_MAX_AGE_SECONDS, evaluateSpread } from "@/lib/risk-config";
import MirasDashboard from "./MirasDashboard";

type Instrument = {
  symbol: string;
  bid?: number;
  ask?: number;
  spread_points?: number;
  spread_status?: string;
  [key: string]: unknown;
};

type Snapshot = {
  packet: {
    utc_timestamp: string;
    commodities: Record<string, { meta: Instrument }>;
    [key: string]: unknown;
  };
  receivedAt: string;
  source?: "mt5" | "drive";
};

type ApiState = {
  snapshot: Snapshot | null;
  age_seconds?: number;
  stale?: boolean;
  mt5_live?: boolean;
  recommendations_locked?: boolean;
  error_code?: string;
  health: { mt5: string; drive: string; redis: string; supabase: string };
  error?: string;
};

const healthNames: Record<string, string> = {
  connected: "متصل",
  configured: "مُعدّ",
  waiting: "بانتظار البيانات",
  offline: "غير متصل",
  not_configured: "غير مُعدّ",
  error: "خطأ اتصال",
  unknown: "غير معروف",
};

function formatPrice(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 }).format(value)
    : "—";
}

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(date) + " UTC";
}

function HealthPill({ label, status }: { label: string; status: string }) {
  const tone = status === "connected" || status === "configured" ? "good" : status === "waiting" ? "warn" : "bad";
  return (
    <div className="health-pill">
      <span className={`health-dot ${tone}`} aria-hidden="true" />
      <span className="health-label">{label}</span>
      <strong className={`health-value ${tone}`}>{healthNames[status] ?? status}</strong>
    </div>
  );
}

function LegacyMonitorHome() {
  const [state, setState] = useState<ApiState | null>(null);
  const [checkedAt, setCheckedAt] = useState<string>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/market/latest", { cache: "no-store" });
      const payload = (await response.json()) as ApiState;
      setState(payload);
    } catch {
      setState({
        snapshot: null,
        mt5_live: false,
        recommendations_locked: true,
        error_code: "ERR_MT5_OFFLINE",
        health: { mt5: "unknown", drive: "unknown", redis: "error", supabase: "unknown" },
        error: "تعذر الوصول إلى الخادم",
      });
    } finally {
      setCheckedAt(new Date().toISOString());
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    // Poll every 10s and only while the tab is visible: each poll is a Redis command on a metered plan.
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const instruments = Object.values(state?.snapshot?.packet.commodities ?? {}).map(({ meta }) => meta);
  const marketStatus = state?.snapshot ? (state.stale ? "stale" : "ready") : "empty";
  // Before the first response arrives we do not claim an outage; afterwards a missing live feed locks recommendations.
  const mt5Offline = state !== null && state.mt5_live !== true;
  const lockReason = mt5Offline ? "ERR_MT5_OFFLINE" : "محرك التحليل غير مُعدّ بعد";

  return (
    <main className="app-shell" dir="rtl">
      <header className="topbar">
        <a className="brand" href="#overview" aria-label="مرصد التداول - الرئيسية">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span><b>مِرصد</b><small>TRADING INTELLIGENCE</small></span>
        </a>
        <div className="topbar-meta">
          <span className={`conn-chip ${mt5Offline ? "offline" : state ? "online" : "pending"}`} role="status">
            <i aria-hidden="true" />
            {mt5Offline ? "ERR_MT5_OFFLINE" : state ? "MT5 مباشر" : "جارٍ الفحص"}
          </span>
          <span className="environment-tag"><i /> بيئة مراقبة فقط</span>
          <span className="utc-clock">UTC · {formatTime(checkedAt)}</span>
        </div>
      </header>

      <section className="health-ribbon" aria-label="صحة النظام">
        <HealthPill label="جسر MT5" status={state?.health.mt5 ?? "unknown"} />
        <HealthPill label="نسخة Drive الاحتياطية" status={state?.health.drive ?? "unknown"} />
        <HealthPill label="Redis اللحظي" status={state?.health.redis ?? "unknown"} />
        <HealthPill label="سجل Supabase" status={state?.health.supabase ?? "unknown"} />
        <HealthPill label="محرك الذكاء الاصطناعي" status="not_configured" />
      </section>

      <div className="content" id="overview">
        <section className="page-heading">
          <div>
            <p className="eyebrow">لوحة المراقبة · النسخة التأسيسية</p>
            <h1>صورة السوق</h1>
            <p className="subheading">الأولوية لإرسال MT5 المباشر مع ملف Drive احتياطي. لا يصدر هذا الإصدار توصيات أو ينفّذ صفقات.</p>
          </div>
          <div className="heading-actions">
            <button className="reco-button" disabled title={lockReason}>
              🔒 طلب توصية · {lockReason}
            </button>
            <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>
              <span className={loading ? "spinner" : "refresh-icon"} aria-hidden="true">↻</span>
              تحديث الحالة
            </button>
          </div>
        </section>

        <section className="summary-grid" aria-label="حالة آخر حزمة">
          <article className="summary-card">
            <span className="card-label">حالة السوق</span>
            <strong className={`summary-value ${marketStatus === "ready" ? "positive" : marketStatus === "stale" ? "warning" : "muted"}`}>
              {marketStatus === "ready" ? "البيانات حديثة" : marketStatus === "stale" ? "البيانات قديمة" : "بانتظار أول حزمة"}
            </strong>
            <small>{state?.snapshot ? `آخر جلب قبل ${state.age_seconds ?? 0} ثانية` : "يظهر آخر تحديث بعد إعداد Redis وتوصيل مصدر البيانات"}</small>
          </article>
          <article className="summary-card">
            <span className="card-label">آخر طابع زمني للحزمة</span>
            <strong className="summary-value ltr-number">{formatTime(state?.snapshot?.packet.utc_timestamp)}</strong>
            <small>المصدر: {state?.snapshot?.source === "drive" ? "ملف Drive الاحتياطي" : state?.snapshot ? "MT5 مباشر" : "—"} · utc_timestamp بتوقيت UTC</small>
          </article>
          <article className="summary-card">
            <span className="card-label">الأدوات المستلمة</span>
            <strong className="summary-value ltr-number">{instruments.length.toString().padStart(2, "0")}</strong>
            <small>{instruments.map((item) => item.symbol).join(" · ") || "لا توجد بيانات حتى الآن"}</small>
          </article>
        </section>

        {state?.error && <div className="notice notice-error" role="status">تعذر قراءة لقطة السوق: {state.error}. تحقق من Redis ومصدر Drive في بيئة الخادم.</div>}
        {state?.stale && <div className="notice notice-warn" role="status">البيانات الواردة أقدم من الحد المسموح ({MT5_LIVE_MAX_AGE_SECONDS} ثانية للبث المباشر)؛ تُعرض للمراقبة فقط ولا يجوز استخدامها لاتخاذ قرار.</div>}

        <section className="panel instruments-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">تغذية البيانات</p><h2>الأسعار المستلمة</h2></div>
            <span className={`live-label ${instruments.length ? "live" : "idle"}`}><i /> {instruments.length ? "تحديث كل 10 ثوانٍ" : "لا توجد تغذية حية"}</span>
          </div>
          {instruments.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>الأداة</th><th>Bid</th><th>Ask</th><th>السبريد / الحد (نقاط)</th><th>حالة السبريد</th></tr></thead>
                <tbody>{instruments.map((instrument) => {
                  const spread = evaluateSpread(instrument.symbol, instrument.spread_points);
                  const vetoed = spread.level === "veto";
                  return (
                    <tr key={instrument.symbol}>
                      <td><span className="symbol-badge">{instrument.symbol}</span></td>
                      <td className="ltr-number">{formatPrice(instrument.bid)}</td>
                      <td className="ltr-number">{formatPrice(instrument.ask)}</td>
                      <td className="ltr-number">{formatPrice(instrument.spread_points)} / {spread.limit}</td>
                      <td>
                        <span className={`price-status ${vetoed ? "spread-warning" : ""}`}>
                          <i /> {vetoed ? "سبريد مرتفع · فيتو" : "ضمن الحد"}
                        </span>
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">⌁</div>
              <h3>لا توجد لقطة سوق محفوظة بعد</h3>
              <p>بعد إعداد Redis وربط MT5 أو ملف Drive الاحتياطي، ستظهر الأدوات هنا تلقائيًا.</p>
              <code dir="ltr">POST /api/ingest</code>
            </div>
          )}
        </section>

        <section className="lower-grid">
          <article className="panel roadmap-panel">
            <div className="panel-heading compact"><div><p className="eyebrow">خارطة التنفيذ</p><h2>مراحل البناء</h2></div></div>
            <ol className="milestone-list">
              <li className="milestone active"><span className="step-number">01</span><div><b>الاستقبال والتخزين</b><small>قيد التنفيذ · MT5 + Redis + سجل Supabase</small></div><span className="step-state">الآن</span></li>
              <li className="milestone"><span className="step-number">02</span><div><b>الوكلاء والقاضي الرياضي</b><small>بعد تثبيت مخطط بيانات MT5 ومفاتيح Gemini</small></div></li>
              <li className="milestone"><span className="step-number">03</span><div><b>التشخيص والمعايرة</b><small>الفيتوهات، حاسبة المخاطرة، وسجل الأخطاء</small></div></li>
              <li className="milestone"><span className="step-number">04</span><div><b>التنبيهات والسجل</b><small>Telegram عند تغيّر الحالة فقط</small></div></li>
            </ol>
          </article>
          <article className="panel setup-panel">
            <div className="panel-heading compact"><div><p className="eyebrow">ما نحتاجه منك لاحقًا</p><h2>إكمال التوصيل</h2></div></div>
            <ul className="setup-list">
              <li><span className="setup-index">1</span><span>ملف EA/Exporter بصيغة MQ5 أو جزء WebRequest لإرسال البيانات.</span></li>
              <li><span className="setup-index">2</span><span>إنشاء Upstash وSupabase وإضافة مفاتيحهما في Vercel، لا ترسلها في المحادثة.</span></li>
              <li><span className="setup-index">3</span><span>لاحقًا: مفتاح Gemini، وحدود السبريد والمخاطرة لكل أداة.</span></li>
            </ul>
            <div className="security-note"><span aria-hidden="true">◆</span> لا تُضمّن مفاتيح API داخل MT5 أو الواجهة أو GitHub.</div>
          </article>
        </section>

        <footer className="footer-note">
          <span>مِرصد · بناء أولي غير مخصص للتنفيذ المالي</span>
          <span>آخر فحص: {formatTime(checkedAt)}</span>
        </footer>
      </div>
    </main>
  );
}

export default function Home() {
  return <MirasDashboard />;
}
