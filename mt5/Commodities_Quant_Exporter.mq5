//+------------------------------------------------------------------+
//|                                   Commodities_Quant_Exporter.mq5 |
//|                                  Copyright 2026, Pro Algo Trader |
//|  Version 12.31 - Multi-Commodity, Schema 2.1, Secure Webhook     |
//+------------------------------------------------------------------+
#property copyright "Pro Algo Trader"
#property version   "12.31"
#property strict

//====================================================================
//                       ENUMS & STRUCTS
//====================================================================
enum ENUM_TRADE_STYLE
{
   STYLE_SCALP,      // Macro: M15 | Micro: M1
   STYLE_DAYTRADE,   // Macro: H1  | Micro: M15
   STYLE_SWING       // Macro: D1  | Micro: H4
};

struct PriceZone
{
   double low;
   double high;
   string status;    // "unmitigated" | "mitigated"
   bool   valid;
};

struct LiquidityLevel
{
   double price;
   bool   swept;
   bool   valid;
};

//====================================================================
//                       INPUT PARAMETERS
//====================================================================
input group "--- 🪙 Commodities & Inter-Market Symbols ---"
input string           Inp_Symbols           = "XAUUSD,XAGUSD,XPTUSD"; // أضف رمز النفط هنا إذا كان متوفراً عند البروكر (مثل USOIL,UKOIL)
input string           Inp_DXY_Symbol        = "";                     // اتركه فارغاً ليحسب DXY تلقائياً من سلة العملات الستة
input string           Inp_GoldFut_Symbol    = "";                     // رمز عقود الذهب الآجلة (اتركه فارغاً لاستخدام الفارق الثابت)
input double           Inp_GoldBasisFallback = 13.0;                   // فارق الآجل عن الفوري للذهب ($)

input group "--- 🎯 Trading Strategy & Risk ---"
input ENUM_TRADE_STYLE Inp_Trade_Style       = STYLE_DAYTRADE;
input int              Inp_Max_Spread_Pts    = 35;                     // حد السبريد المسموح (بالنقاط)

input group "--- ⚙️ Export & Webhook (Vercel / FastAPI / n8n) ---"
input int              Inp_TimerSeconds      = 5;                      // سرعة الإرسال للداش بورد (بالثواني)
input int              Inp_DriveSyncSec      = 60;                     // سرعة تحديث ملف Google Drive (بالثواني)
input string           Inp_FileName          = "COMMODITIES_QUANT_DATA.json";
input bool             Inp_EnableWebhook     = false;                  // فعّله إلى true عند ربط رابط Vercel
input string           Inp_WebhookURL        = "";                     // مثال: https://your-app.vercel.app/api/ingest
input string           Inp_WebhookSecret     = "";                     // رمز الحماية Bearer Token

input group "--- 🕰️ ICT Killzones (Broker Server Time) ---"
input int              Inp_NY_Midnight_Hr    = 7;
input int              Inp_NY_Open_Hr        = 16;
input int              Inp_NY_Open_Min       = 30;
input int              Inp_ADR_Period        = 14;

input group "--- 🧊 Volume Profile & Candles Budget ---"
input int              Inp_VP_Bars           = 288;
input int              Inp_VP_Bins           = 100;
input int              Inp_Bars_D1           = 15;
input int              Inp_Bars_H4           = 25;
input int              Inp_Bars_H1           = 35;
input int              Inp_Bars_M15          = 40;
input int              Inp_Bars_M5           = 30;

input group "--- 📱 Telegram Alerts (Set in Inputs, Never Hardcode) ---"
input bool             Inp_EnableTelegram    = false;
input string           Inp_TelegramToken     = "";
input string           Inp_TelegramChatID    = "";

//====================================================================
//                       GLOBAL STATE
//====================================================================
ENUM_TIMEFRAMES G_TF_Macro;
ENUM_TIMEFRAMES G_TF_Micro;
string          G_Symbols[];
int             G_SymbolCount = 0;

double          G_LastChoch[];
datetime        G_LastVolAlert[];
datetime        G_LastChochAlert[];
datetime        G_LastFileWrite = 0;
datetime        G_LastWebhookErrorLog = 0;

//====================================================================
//                       HELPERS & FORMATTING
//====================================================================
string DoubleOrNull(double val, int digits)
{
   if(val <= 0.0 || !MathIsValidNumber(val)) return "null";
   return DoubleToString(val, digits);
}

string FormatISO8601UTC(datetime utc_time)
{
   MqlDateTime dt;
   TimeToStruct(utc_time, dt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
                       dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec);
}

string FormatZoneJson(const PriceZone &z, int digits)
{
   if(!z.valid) return "null";
   return StringFormat("{\"low\":%s,\"high\":%s,\"status\":\"%s\"}",
                       DoubleToString(z.low, digits),
                       DoubleToString(z.high, digits),
                       z.status);
}

string FormatLiqJson(const LiquidityLevel &l, int digits)
{
   if(!l.valid) return "null";
   return StringFormat("{\"price\":%s,\"swept\":%s}",
                       DoubleToString(l.price, digits),
                       l.swept ? "true" : "false");
}

//====================================================================
//                       NETWORK (TELEGRAM & WEBHOOK)
//====================================================================
void SendTelegramMessage(string text)
{
   if(!Inp_EnableTelegram || Inp_TelegramToken == "" || Inp_TelegramChatID == "") return;

   string url = "https://api.telegram.org/bot" + Inp_TelegramToken + "/sendMessage";
   string encoded = text;
   StringReplace(encoded, " ", "%20");
   StringReplace(encoded, "\n", "%0A");

   string params = "chat_id=" + Inp_TelegramChatID + "&text=" + encoded + "&parse_mode=HTML";
   char post[], result[];
   StringToCharArray(params, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0) ArrayResize(post, ArraySize(post) - 1);

   string req_headers = "Content-Type: application/x-www-form-urlencoded\r\n";
   string res_headers = "";
   ResetLastError();
   int res = WebRequest("POST", url, req_headers, 5000, post, result, res_headers);
   if(res == -1)
      Print("[Telegram Error] Code: ", GetLastError(), " | Add https://api.telegram.org to Allowed URLs.");
}

bool PostWebhookPayload(const string &json_payload)
{
   if(!Inp_EnableWebhook) return false;

   string endpoint = Inp_WebhookURL;
   string secret = Inp_WebhookSecret;
   StringTrimLeft(endpoint);
   StringTrimRight(endpoint);
   StringTrimLeft(secret);
   StringTrimRight(secret);

   if(endpoint == "" || secret == "")
   {
      datetime now = TimeCurrent();
      if(G_LastWebhookErrorLog == 0 || now - G_LastWebhookErrorLog >= 60)
      {
         Print("[Webhook Disabled] Set both Inp_WebhookURL and Inp_WebhookSecret; no unauthenticated request was sent.");
         G_LastWebhookErrorLog = now;
      }
      return false;
   }
   if(StringFind(endpoint, "https://") != 0)
   {
      datetime now = TimeCurrent();
      if(G_LastWebhookErrorLog == 0 || now - G_LastWebhookErrorLog >= 60)
      {
         Print("[Webhook Disabled] HTTPS is required to protect the Bearer token.");
         G_LastWebhookErrorLog = now;
      }
      return false;
   }

   char post[], result[];
   StringToCharArray(json_payload, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0) ArrayResize(post, ArraySize(post) - 1);

   string req_headers = "Content-Type: application/json\r\n";
   req_headers += "Authorization: Bearer " + secret + "\r\n";

   string res_headers = "";
   ResetLastError();
   int res = WebRequest("POST", endpoint, req_headers, 3000, post, result, res_headers);
   if(res == -1)
   {
      datetime now = TimeCurrent();
      if(G_LastWebhookErrorLog == 0 || now - G_LastWebhookErrorLog >= 60)
      {
         Print("[Webhook Error] WebRequest failed. LastError: ", GetLastError(),
               " | Add the endpoint host under Tools > Options > Expert Advisors > Allow WebRequest.");
         G_LastWebhookErrorLog = now;
      }
      return false;
   }
   if(res < 200 || res >= 300)
   {
      datetime now = TimeCurrent();
      if(G_LastWebhookErrorLog == 0 || now - G_LastWebhookErrorLog >= 60)
      {
         Print("[Webhook Error] Server returned HTTP ", res, ". Check endpoint, token, and server logs.");
         G_LastWebhookErrorLog = now;
      }
      return false;
   }
   return true;
}

//====================================================================
//                       INIT & DEINIT
//====================================================================
int OnInit()
{
   if(Inp_Trade_Style == STYLE_SCALP)         { G_TF_Macro = PERIOD_M15; G_TF_Micro = PERIOD_M1; }
   else if(Inp_Trade_Style == STYLE_DAYTRADE) { G_TF_Macro = PERIOD_H1;  G_TF_Micro = PERIOD_M15; }
   else                                       { G_TF_Macro = PERIOD_D1;  G_TF_Micro = PERIOD_H4; }

   string raw[];
   int count = StringSplit(Inp_Symbols, ',', raw);
   ArrayResize(G_Symbols, 0);
   for(int i = 0; i < count; i++)
   {
      string s = raw[i];
      StringTrimLeft(s);
      StringTrimRight(s);
      if(s == "") continue;
      if(SymbolSelect(s, true))
      {
         int idx = ArraySize(G_Symbols);
         ArrayResize(G_Symbols, idx + 1);
         G_Symbols[idx] = s;
         MarketBookAdd(s);
         iTime(s, PERIOD_M5, 0);
         iTime(s, PERIOD_H1, 0);
         iTime(s, PERIOD_D1, 0);
      }
      else
      {
         Print("[Init Warning] Symbol not found in broker Market Watch: ", s);
      }
   }

   G_SymbolCount = ArraySize(G_Symbols);
   if(G_SymbolCount == 0)
   {
      Print("[Init Error] No valid symbols loaded. Fallback to chart symbol: ", _Symbol);
      ArrayResize(G_Symbols, 1);
      G_Symbols[0] = _Symbol;
      G_SymbolCount = 1;
      MarketBookAdd(_Symbol);
   }

   if(Inp_DXY_Symbol != "")     SymbolSelect(Inp_DXY_Symbol, true);
   if(Inp_GoldFut_Symbol != "") SymbolSelect(Inp_GoldFut_Symbol, true);

   ArrayResize(G_LastChoch, G_SymbolCount);      ArrayInitialize(G_LastChoch, 0.0);
   ArrayResize(G_LastVolAlert, G_SymbolCount);   ArrayInitialize(G_LastVolAlert, 0);
   ArrayResize(G_LastChochAlert, G_SymbolCount); ArrayInitialize(G_LastChochAlert, 0);

   EventSetTimer(MathMax(1, Inp_TimerSeconds));
   Print("[Quant Exporter V12.31] Active for ", G_SymbolCount, " commodities: ", Inp_Symbols);
   SendTelegramMessage("✅ <b>Quant Exporter V12.31 Started</b>\nMonitoring: " + Inp_Symbols);

   ExportAllCommodities();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   for(int i = 0; i < G_SymbolCount; i++) MarketBookRelease(G_Symbols[i]);
}

void OnTimer()
{
   ExportAllCommodities();
}

//====================================================================
//                       QUANT ENGINES
//====================================================================
double GetLiveDXY(double &dxy_change_pct)
{
   dxy_change_pct = 0.0;

   if(Inp_DXY_Symbol != "")
   {
      double direct_bid = SymbolInfoDouble(Inp_DXY_Symbol, SYMBOL_BID);
      double direct_open = iOpen(Inp_DXY_Symbol, PERIOD_D1, 0);
      if(direct_bid > 0.0)
      {
         if(direct_open > 0.0) dxy_change_pct = ((direct_bid - direct_open) / direct_open) * 100.0;
         return direct_bid;
      }
   }

   string pairs[6] = {"EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDSEK", "USDCHF"};
   double w[6]     = {-0.576,   0.136,    -0.119,   0.091,    0.042,    0.036};
   double b[6], o[6];

   for(int i = 0; i < 6; i++)
   {
      SymbolSelect(pairs[i], true);
      b[i] = SymbolInfoDouble(pairs[i], SYMBOL_BID);
      o[i] = iOpen(pairs[i], PERIOD_D1, 0);
      if(b[i] <= 0.0) return 0.0;
   }

   // تصحيح علامة الضرب (*) في السطر الثاني لمعادلة ICE DXY
   double dxy_now = 50.14348112 * MathPow(b[0], w[0]) * MathPow(b[1], w[1]) * MathPow(b[2], w[2])
                                * MathPow(b[3], w[3]) * MathPow(b[4], w[4]) * MathPow(b[5], w[5]);

   if(o[0] > 0 && o[1] > 0 && o[2] > 0 && o[3] > 0 && o[4] > 0 && o[5] > 0)
   {
      double dxy_open = 50.14348112 * MathPow(o[0], w[0]) * MathPow(o[1], w[1]) * MathPow(o[2], w[2])
                                    * MathPow(o[3], w[3]) * MathPow(o[4], w[4]) * MathPow(o[5], w[5]);
      if(dxy_open > 0.0) dxy_change_pct = ((dxy_now - dxy_open) / dxy_open) * 100.0;
   }
   return dxy_now;
}

double CalculateATR(const string sym, ENUM_TIMEFRAMES tf, int period)
{
   double tr_sum = 0.0;
   for(int i = 1; i <= period; i++)
   {
      double h = iHigh(sym, tf, i);
      double l = iLow(sym, tf, i);
      double pc = iClose(sym, tf, i + 1);
      if(h <= 0 || l <= 0 || pc <= 0) return 0.0;
      double tr = MathMax(h - l, MathMax(MathAbs(h - pc), MathAbs(l - pc)));
      tr_sum += tr;
   }
   return (period > 0) ? (tr_sum / period) : 0.0;
}

double CalculateHurst(const string sym, ENUM_TIMEFRAMES tf, int bars = 64)
{
   double ret[];
   ArrayResize(ret, bars);
   double mean = 0.0;
   int valid = 0;

   for(int i = 0; i < bars; i++)
   {
      double c1 = iClose(sym, tf, i + 1);
      double c2 = iClose(sym, tf, i + 2);
      if(c1 <= 0.0 || c2 <= 0.0) return 0.50;
      ret[i] = MathLog(c1 / c2);
      mean += ret[i];
      valid++;
   }
   if(valid < 20) return 0.50;
   mean /= valid;

   double cum = 0.0, max_cum = -1e18, min_cum = 1e18, sum_sq = 0.0;
   for(int i = 0; i < valid; i++)
   {
      double dev = ret[i] - mean;
      cum += dev;
      if(cum > max_cum) max_cum = cum;
      if(cum < min_cum) min_cum = cum;
      sum_sq += dev * dev;
   }

   double R = max_cum - min_cum;
   double S = MathSqrt(sum_sq / valid);
   if(R <= 0.0 || S <= 1e-12) return 0.50;

   double H = MathLog(R / S) / MathLog((double)valid);
   if(H < 0.05) H = 0.05;
   if(H > 0.95) H = 0.95;
   return H;
}

// المؤشرات الفنية (EMA 20/50/200 + RSI 14) ومعامل ارتباط بيرسون مع DXY و XAGUSD
string GetQuantIndicatorsAndCorr(const string sym, int digits)
{
   double ema20_m15 = 0, ema50_m15 = 0, ema200_h1 = 0, rsi_m15 = 50, rsi_h1 = 50;

   int h_e20  = iMA(sym, PERIOD_M15, 20, 0, MODE_EMA, PRICE_CLOSE);
   int h_e50  = iMA(sym, PERIOD_M15, 50, 0, MODE_EMA, PRICE_CLOSE);
   int h_e200 = iMA(sym, PERIOD_H1, 200, 0, MODE_EMA, PRICE_CLOSE);
   int h_rm15 = iRSI(sym, PERIOD_M15, 14, PRICE_CLOSE);
   int h_rh1  = iRSI(sym, PERIOD_H1, 14, PRICE_CLOSE);

   double buf[1];
   if(h_e20  != INVALID_HANDLE && CopyBuffer(h_e20,  0, 0, 1, buf) > 0) ema20_m15 = buf[0];
   if(h_e50  != INVALID_HANDLE && CopyBuffer(h_e50,  0, 0, 1, buf) > 0) ema50_m15 = buf[0];
   if(h_e200 != INVALID_HANDLE && CopyBuffer(h_e200, 0, 0, 1, buf) > 0) ema200_h1 = buf[0];
   if(h_rm15 != INVALID_HANDLE && CopyBuffer(h_rm15, 0, 0, 1, buf) > 0) rsi_m15   = buf[0];
   if(h_rh1  != INVALID_HANDLE && CopyBuffer(h_rh1,  0, 0, 1, buf) > 0) rsi_h1    = buf[0];

   if(h_e20  != INVALID_HANDLE) IndicatorRelease(h_e20);
   if(h_e50  != INVALID_HANDLE) IndicatorRelease(h_e50);
   if(h_e200 != INVALID_HANDLE) IndicatorRelease(h_e200);
   if(h_rm15 != INVALID_HANDLE) IndicatorRelease(h_rm15);
   if(h_rh1  != INVALID_HANDLE) IndicatorRelease(h_rh1);

   // معامل الارتباط على آخر 50 شمعة H1 مع EURUSD (معكوس DXY) ومع XAGUSD
   double sx=0, sy=0, sxy=0, sx2=0, sy2=0;
   double gx=0, gy=0, gxy=0, gx2=0, gy2=0;
   int valid_dxy = 0, valid_xag = 0;

   for(int i = 1; i <= 50; i++)
   {
      double x = iClose(sym, PERIOD_H1, i);
      double y_eur = iClose("EURUSD", PERIOD_H1, i);
      double y_xag = iClose("XAGUSD", PERIOD_H1, i);
      if(x > 0 && y_eur > 0)
      {
         sx += x; sy += y_eur; sxy += x*y_eur; sx2 += x*x; sy2 += y_eur*y_eur;
         valid_dxy++;
      }
      if(x > 0 && y_xag > 0)
      {
         gx += x; gy += y_xag; gxy += x*y_xag; gx2 += x*x; gy2 += y_xag*y_xag;
         valid_xag++;
      }
   }

   double corr_dxy = 0.0, corr_xag = 0.0;
   if(valid_dxy > 20)
   {
      double den = MathSqrt((valid_dxy*sx2 - sx*sx) * (valid_dxy*sy2 - sy*sy));
      if(den > 1e-12) corr_dxy = -((valid_dxy*sxy - sx*sy) / den);
   }
   if(valid_xag > 20)
   {
      double den_g = MathSqrt((valid_xag*gx2 - gx*gx) * (valid_xag*gy2 - gy*gy));
      if(den_g > 1e-12) corr_xag = (valid_xag*gxy - gx*gy) / den_g;
   }

   return StringFormat(
      "\"indicators\":{\"ema20_m15\":%s,\"ema50_m15\":%s,\"ema200_h1\":%s,\"rsi14_m15\":%.1f,\"rsi14_h1\":%.1f,\"corr_dxy_h1\":%.2f,\"corr_xag_h1\":%.2f},",
      DoubleOrNull(ema20_m15, digits), DoubleOrNull(ema50_m15, digits),
      DoubleOrNull(ema200_h1, digits), rsi_m15, rsi_h1, corr_dxy, corr_xag
   );
}

void GetMetaContext(const string sym, int &spread_pts, double &spread_usd, double &daily_chg,
                    string &spread_status, string &session, bool &in_killzone)
{
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   spread_pts = (int)SymbolInfoInteger(sym, SYMBOL_SPREAD);
   spread_usd = MathMax(0.0, ask - bid);
   spread_status = (spread_pts > Inp_Max_Spread_Pts) ? "WARNING_HIGH_SPREAD" : "NORMAL";

   double daily_open = iOpen(sym, PERIOD_D1, 0);
   daily_chg = (daily_open > 0.0) ? ((bid - daily_open) / daily_open) * 100.0 : 0.0;

   MqlDateTime dt;
   TimeCurrent(dt);
   int h = dt.hour;
   in_killzone = false;

   if(h >= 1 && h < 8)       { session = "Asian"; }
   else if(h >= 8 && h < 13) { session = "London"; in_killzone = (h >= 9 && h <= 11); }
   else if(h >= 13 && h < 17){ session = "London_NY_Overlap"; in_killzone = true; }
   else if(h >= 17 && h < 22){ session = "New_York"; in_killzone = (h <= 18); }
   else                      { session = "Sydney_Quiet"; }
}

void GetICTData(const string sym, double &midnight_open, double &ny_830_open, double &adr, double &exhaustion_pct)
{
   midnight_open = 0.0; ny_830_open = 0.0; adr = 0.0; exhaustion_pct = 0.0;

   double sum_range = 0.0;
   for(int i = 1; i <= Inp_ADR_Period; i++)
      sum_range += (iHigh(sym, PERIOD_D1, i) - iLow(sym, PERIOD_D1, i));
   adr = (Inp_ADR_Period > 0) ? (sum_range / Inp_ADR_Period) : 0.0;

   double curr_range = iHigh(sym, PERIOD_D1, 0) - iLow(sym, PERIOD_D1, 0);
   if(adr > 0.0) exhaustion_pct = (curr_range / adr) * 100.0;

   MqlDateTime dt;
   TimeToStruct(iTime(sym, PERIOD_D1, 0), dt);
   dt.hour = Inp_NY_Midnight_Hr; dt.min = 0; dt.sec = 0;
   int shift_mid = iBarShift(sym, PERIOD_M5, StructToTime(dt), true);
   midnight_open = (shift_mid >= 0) ? iOpen(sym, PERIOD_M5, shift_mid) : iOpen(sym, PERIOD_D1, 0);

   dt.hour = Inp_NY_Open_Hr; dt.min = Inp_NY_Open_Min; dt.sec = 0;
   datetime ny_t = StructToTime(dt);
   if(TimeCurrent() >= ny_t)
   {
      int shift_ny = iBarShift(sym, PERIOD_M5, ny_t, true);
      if(shift_ny >= 0) ny_830_open = iOpen(sym, PERIOD_M5, shift_ny);
   }
}

void GetDailyVWAP(const string sym, double &vwap, double &sd1_u, double &sd1_d,
                  double &sd2_u, double &sd2_d, string &slope)
{
   vwap = 0; sd1_u = 0; sd1_d = 0; sd2_u = 0; sd2_d = 0; slope = "FLAT";
   int bars = Bars(sym, PERIOD_M1, iTime(sym, PERIOD_D1, 0), TimeCurrent());
   if(bars <= 1) return;

   double sum_pv = 0.0, sum_v = 0.0, sum_dev = 0.0;
   double prev_sum_pv = 0.0, prev_sum_v = 0.0;

   for(int i = 0; i < bars; i++)
   {
      double typ = (iHigh(sym, PERIOD_M1, i) + iLow(sym, PERIOD_M1, i) + iClose(sym, PERIOD_M1, i)) / 3.0;
      long v = iTickVolume(sym, PERIOD_M1, i);
      sum_pv += typ * v;
      sum_v  += (double)v;
      if(i >= 15) { prev_sum_pv += typ * v; prev_sum_v += (double)v; }
   }
   if(sum_v <= 0.0) return;
   vwap = sum_pv / sum_v;

   if(prev_sum_v > 0.0)
   {
      double prev_vwap = prev_sum_pv / prev_sum_v;
      double diff = vwap - prev_vwap;
      double thr = SymbolInfoDouble(sym, SYMBOL_POINT) * 10.0;
      if(diff > thr)       slope = "UP";
      else if(diff < -thr) slope = "DOWN";
   }

   for(int i = 0; i < bars; i++)
   {
      double typ = (iHigh(sym, PERIOD_M1, i) + iLow(sym, PERIOD_M1, i) + iClose(sym, PERIOD_M1, i)) / 3.0;
      sum_dev += (double)iTickVolume(sym, PERIOD_M1, i) * MathPow(typ - vwap, 2);
   }
   double sd = MathSqrt(sum_dev / sum_v);
   sd1_u = vwap + sd;       sd1_d = vwap - sd;
   sd2_u = vwap + (2.0*sd); sd2_d = vwap - (2.0*sd);
}

// تحديث: إضافة synthetic_cvd_m15 لقياس التدفق اللحظي بجانب دلتا اليوم الكاملة
void GetMicrostructureVolume(const string sym, double &poc, double &vaH, double &vaL,
                             long &synthetic_cvd_session, long &synthetic_cvd_m15,
                             double &rvol_m15, string &state)
{
   poc = 0; vaH = 0; vaL = 0;
   synthetic_cvd_session = 0; synthetic_cvd_m15 = 0;
   rvol_m15 = 1.0; state = "Normal";

   int low_idx  = iLowest(sym, PERIOD_M5, MODE_LOW, Inp_VP_Bars, 0);
   int high_idx = iHighest(sym, PERIOD_M5, MODE_HIGH, Inp_VP_Bars, 0);
   if(low_idx < 0 || high_idx < 0) return;

   double minP = iLow(sym, PERIOD_M5, low_idx);
   double maxP = iHigh(sym, PERIOD_M5, high_idx);
   double step = (maxP - minP) / Inp_VP_Bins;
   if(step <= 0.0) return;

   double bins[];
   ArrayResize(bins, Inp_VP_Bins);
   ArrayInitialize(bins, 0.0);
   double total_vol = 0.0;

   for(int i = 0; i < Inp_VP_Bars; i++)
   {
      int idx = (int)((iClose(sym, PERIOD_M5, i) - minP) / step);
      if(idx >= 0 && idx < Inp_VP_Bins)
      {
         double tv = (double)iTickVolume(sym, PERIOD_M5, i);
         bins[idx] += tv;
         total_vol += tv;
      }
   }

   int poc_idx = ArrayMaximum(bins);
   poc = minP + (poc_idx * step) + (step * 0.5);

   double va_vol = bins[poc_idx];
   double target_va = total_vol * 0.70;
   int up = poc_idx, dn = poc_idx;
   while(va_vol < target_va && (up < Inp_VP_Bins - 1 || dn > 0))
   {
      double vol_up = (up < Inp_VP_Bins - 1) ? bins[up + 1] : -1.0;
      double vol_dn = (dn > 0)               ? bins[dn - 1] : -1.0;
      if(vol_up >= vol_dn && up < Inp_VP_Bins - 1) { up++; va_vol += bins[up]; }
      else if(dn > 0)                               { dn--; va_vol += bins[dn]; }
      else break;
   }
   vaH = minP + ((up + 1) * step);
   vaL = minP + (dn * step);

   MqlTick ticks[];
   ulong from_ms    = (ulong)iTime(sym, PERIOD_D1, 0) * 1000;
   ulong m15_from_ms = (ulong)iTime(sym, PERIOD_M15, 0) * 1000;
   ulong to_ms      = (ulong)TimeCurrent() * 1000;
   int copied = CopyTicksRange(sym, ticks, COPY_TICKS_ALL, from_ms, to_ms);
   if(copied > 1)
   {
      double prev_bid = ticks[0].bid;
      for(int i = 1; i < copied; i++)
      {
         bool has_buy  = ((ticks[i].flags & TICK_FLAG_BUY)  == TICK_FLAG_BUY);
         bool has_sell = ((ticks[i].flags & TICK_FLAG_SELL) == TICK_FLAG_SELL);
         long w = (ticks[i].volume > 0) ? (long)ticks[i].volume : 1;
         long delta = 0;

         if(has_buy && !has_sell)      delta = w;
         else if(has_sell && !has_buy) delta = -w;
         else
         {
            if(ticks[i].bid > prev_bid)      delta = 1;
            else if(ticks[i].bid < prev_bid) delta = -1;
         }
         synthetic_cvd_session += delta;
         if((ulong)ticks[i].time_msc >= m15_from_ms)
            synthetic_cvd_m15 += delta;

         if(ticks[i].bid > 0) prev_bid = ticks[i].bid;
      }
   }

   double sum_vol = 0.0;
   for(int i = 1; i <= 20; i++) sum_vol += (double)iTickVolume(sym, PERIOD_M15, i);
   double avg_vol = sum_vol / 20.0;
   double curr_vol = (double)iTickVolume(sym, PERIOD_M15, 0);
   rvol_m15 = (avg_vol > 0.0) ? (curr_vol / avg_vol) : 1.0;

   if(rvol_m15 > 1.50)      state = "High";
   else if(rvol_m15 < 0.60) state = "Low";
   else                     state = "Normal";
}

// تحديث: عكس BOS/ChoCh في الهبوط + استخراج أقرب FVG و Order Block غير مختبرين فقط
void GetSMC(const string sym, ENUM_TIMEFRAMES tf, string &trend_bias, double &bos, double &choch,
            PriceZone &fvg_bull, PriceZone &fvg_bear, PriceZone &ob_bull, PriceZone &ob_bear)
{
   fvg_bull.valid = false; fvg_bear.valid = false;
   ob_bull.valid  = false; ob_bear.valid  = false;

   double bid  = SymbolInfoDouble(sym, SYMBOL_BID);
   double hi50 = iHigh(sym, tf, iHighest(sym, tf, MODE_HIGH, 50, 3));
   double lo50 = iLow(sym, tf, iLowest(sym, tf, MODE_LOW, 50, 3));
   double eq   = (hi50 + lo50) * 0.5;
   double c0   = iClose(sym, tf, 1);
   double c10  = iClose(sym, tf, 10);

   if(c0 > eq && c0 > c10)      { trend_bias = "BULLISH"; bos = hi50; choch = lo50; }
   else if(c0 < eq && c0 < c10) { trend_bias = "BEARISH"; bos = lo50; choch = hi50; }
   else                         { trend_bias = "NEUTRAL"; bos = hi50; choch = lo50; }

   for(int i = 2; i < 40; i++)
   {
      // أقرب FVG صاعد غير مكسور أسفل السعر
      if(!fvg_bull.valid)
      {
         double low_after   = iLow(sym, tf, i - 1);
         double high_before = iHigh(sym, tf, i + 1);
         if(low_after > high_before && bid >= high_before)
         {
            fvg_bull.low    = high_before;
            fvg_bull.high   = low_after;
            fvg_bull.valid  = true;
            fvg_bull.status = (bid <= low_after) ? "mitigated" : "unmitigated";
         }
      }
      // أقرب FVG هابط غير مخترق أعلى السعر
      if(!fvg_bear.valid)
      {
         double high_after = iHigh(sym, tf, i - 1);
         double low_before = iLow(sym, tf, i + 1);
         if(high_after < low_before && bid <= low_before)
         {
            fvg_bear.low    = high_after;
            fvg_bear.high   = low_before;
            fvg_bear.valid  = true;
            fvg_bear.status = (bid >= high_after) ? "mitigated" : "unmitigated";
         }
      }
      // أقرب Bullish Order Block (آخر شمعة هابطة قبل اندفاع صاعد يكسر قمتها)
      if(!ob_bull.valid && iClose(sym, tf, i) < iOpen(sym, tf, i) && iClose(sym, tf, i - 1) > iHigh(sym, tf, i))
      {
         double ob_l = iLow(sym, tf, i), ob_h = iHigh(sym, tf, i);
         if(bid >= ob_l)
         {
            ob_bull.low = ob_l; ob_bull.high = ob_h; ob_bull.valid = true;
            ob_bull.status = (bid <= ob_h) ? "mitigated" : "unmitigated";
         }
      }
      // أقرب Bearish Order Block (آخر شمعة صاعدة قبل هبوط يكسر قاعها)
      if(!ob_bear.valid && iClose(sym, tf, i) > iOpen(sym, tf, i) && iClose(sym, tf, i - 1) < iLow(sym, tf, i))
      {
         double ob_l = iLow(sym, tf, i), ob_h = iHigh(sym, tf, i);
         if(bid <= ob_h)
         {
            ob_bear.low = ob_l; ob_bear.high = ob_h; ob_bear.valid = true;
            ob_bear.status = (bid >= ob_l) ? "mitigated" : "unmitigated";
         }
      }

      if(fvg_bull.valid && fvg_bear.valid && ob_bull.valid && ob_bear.valid) break;
   }
}

void GetLiquidityPools(const string sym, LiquidityLevel &pdh, LiquidityLevel &pdl,
                       LiquidityLevel &pwh, LiquidityLevel &pwl,
                       LiquidityLevel &ah,  LiquidityLevel &al,
                       LiquidityLevel &lh,  LiquidityLevel &ll)
{
   double day_h = iHigh(sym, PERIOD_D1, 0);
   double day_l = iLow(sym, PERIOD_D1, 0);

   pdh.price = iHigh(sym, PERIOD_D1, 1); pdh.valid = (pdh.price > 0); pdh.swept = (day_h > pdh.price);
   pdl.price = iLow(sym, PERIOD_D1, 1);  pdl.valid = (pdl.price > 0); pdl.swept = (day_l < pdl.price);

   pwh.price = iHigh(sym, PERIOD_W1, 1); pwh.valid = (pwh.price > 0); pwh.swept = (iHigh(sym, PERIOD_W1, 0) > pwh.price);
   pwl.price = iLow(sym, PERIOD_W1, 1);  pwl.valid = (pwl.price > 0); pwl.swept = (iLow(sym, PERIOD_W1, 0) < pwl.price);

   datetime d0 = iTime(sym, PERIOD_D1, 0);
   int a_s = iBarShift(sym, PERIOD_M15, d0);
   int a_e = iBarShift(sym, PERIOD_M15, d0 + 8 * 3600);
   if(a_s >= 0 && a_e >= 0 && a_s > a_e)
   {
      ah.price = iHigh(sym, PERIOD_M15, iHighest(sym, PERIOD_M15, MODE_HIGH, a_s - a_e, a_e));
      al.price = iLow(sym, PERIOD_M15, iLowest(sym, PERIOD_M15, MODE_LOW, a_s - a_e, a_e));
      ah.valid = (ah.price > 0); al.valid = (al.price > 0);
      double post_a_h = (a_e > 0) ? iHigh(sym, PERIOD_M15, iHighest(sym, PERIOD_M15, MODE_HIGH, a_e, 0)) : 0;
      double post_a_l = (a_e > 0) ? iLow(sym, PERIOD_M15, iLowest(sym, PERIOD_M15, MODE_LOW, a_e, 0)) : 1e18;
      ah.swept = (a_e > 0 && post_a_h > ah.price);
      al.swept = (a_e > 0 && post_a_l < al.price);
   }
   else { ah.valid = false; al.valid = false; }

   int l_s = iBarShift(sym, PERIOD_M15, d0 + 8 * 3600);
   int l_e = iBarShift(sym, PERIOD_M15, d0 + 16 * 3600);
   if(l_s >= 0 && l_e >= 0 && l_s > l_e)
   {
      lh.price = iHigh(sym, PERIOD_M15, iHighest(sym, PERIOD_M15, MODE_HIGH, l_s - l_e, l_e));
      ll.price = iLow(sym, PERIOD_M15, iLowest(sym, PERIOD_M15, MODE_LOW, l_s - l_e, l_e));
      lh.valid = (lh.price > 0); ll.valid = (ll.price > 0);
      double post_l_h = (l_e > 0) ? iHigh(sym, PERIOD_M15, iHighest(sym, PERIOD_M15, MODE_HIGH, l_e, 0)) : 0;
      double post_l_l = (l_e > 0) ? iLow(sym, PERIOD_M15, iLowest(sym, PERIOD_M15, MODE_LOW, l_e, 0)) : 1e18;
      lh.swept = (l_e > 0 && post_l_h > lh.price);
      ll.swept = (l_e > 0 && post_l_l < ll.price);
   }
   else { lh.valid = false; ll.valid = false; }
}

string GetDOMBuyPressure(const string sym)
{
   MqlBookInfo book[];
   if(!MarketBookGet(sym, book) || ArraySize(book) == 0) return "null";

   double bid_vol = 0.0, ask_vol = 0.0;
   int limit = MathMin(10, ArraySize(book));
   for(int i = 0; i < limit; i++)
   {
      if(book[i].type == BOOK_TYPE_SELL) ask_vol += (double)book[i].volume;
      if(book[i].type == BOOK_TYPE_BUY)  bid_vol += (double)book[i].volume;
   }
   double tot = bid_vol + ask_vol;
   if(tot <= 0.0) return "null";
   return DoubleToString((bid_vol / tot) * 100.0, 2);
}

string GetCandlesJSON(const string sym, ENUM_TIMEFRAMES tf, int count, int digits)
{
   int avail = Bars(sym, tf);
   int n = MathMin(count, avail);
   string js = "[";
   for(int i = n - 1; i >= 0; i--)
   {
      js += "{\"t\":\"" + TimeToString(iTime(sym, tf, i), TIME_DATE|TIME_MINUTES) + "\",";
      js += "\"o\":" + DoubleToString(iOpen(sym, tf, i), digits) + ",";
      js += "\"h\":" + DoubleToString(iHigh(sym, tf, i), digits) + ",";
      js += "\"l\":" + DoubleToString(iLow(sym, tf, i), digits) + ",";
      js += "\"c\":" + DoubleToString(iClose(sym, tf, i), digits) + ",";
      js += "\"v\":" + IntegerToString(iTickVolume(sym, tf, i)) + "}";
      if(i > 0) js += ",";
   }
   js += "]";
   return js;
}

//====================================================================
//                       BUILD SINGLE COMMODITY JSON
//====================================================================
string BuildCommodityJSON(int idx)
{
   string sym = G_Symbols[idx];
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);

   int spread_pts; double spread_usd, daily_chg;
   string spread_status, session; bool in_kz;
   GetMetaContext(sym, spread_pts, spread_usd, daily_chg, spread_status, session, in_kz);

   double mid_open, ny_open, adr, exh_pct;
   GetICTData(sym, mid_open, ny_open, adr, exh_pct);

   double vwap, sd1_u, sd1_d, sd2_u, sd2_d; string vwap_slope;
   GetDailyVWAP(sym, vwap, sd1_u, sd1_d, sd2_u, sd2_d, vwap_slope);

   double poc, vaH, vaL, rvol_m15;
   long synth_cvd_session, synth_cvd_m15;
   string vol_state;
   GetMicrostructureVolume(sym, poc, vaH, vaL, synth_cvd_session, synth_cvd_m15, rvol_m15, vol_state);

   string mac_bias, mic_bias;
   double mac_bos, mac_choch, mic_bos, mic_choch;
   PriceZone mac_fvg_b, mac_fvg_s, mac_ob_b, mac_ob_s;
   PriceZone mic_fvg_b, mic_fvg_s, mic_ob_b, mic_ob_s;
   GetSMC(sym, G_TF_Macro, mac_bias, mac_bos, mac_choch, mac_fvg_b, mac_fvg_s, mac_ob_b, mac_ob_s);
   GetSMC(sym, G_TF_Micro, mic_bias, mic_bos, mic_choch, mic_fvg_b, mic_fvg_s, mic_ob_b, mic_ob_s);

   LiquidityLevel pdh, pdl, pwh, pwl, ah, al, lh, ll;
   GetLiquidityPools(sym, pdh, pdl, pwh, pwl, ah, al, lh, ll);

   double atr_m5  = CalculateATR(sym, PERIOD_M5, 14);
   double atr_m15 = CalculateATR(sym, PERIOD_M15, 14);
   double atr_h1  = CalculateATR(sym, PERIOD_H1, 14);
   double atr_d1  = CalculateATR(sym, PERIOD_D1, 14);

   double hurst_m15 = CalculateHurst(sym, PERIOD_M15, 64);
   double hurst_h1  = CalculateHurst(sym, PERIOD_H1, 64);
   string regime = (hurst_m15 > 0.55) ? "TRENDING" : (hurst_m15 < 0.45) ? "MEAN_REVERTING" : "NOISE";

   if(vol_state == "High" && (TimeCurrent() - G_LastVolAlert[idx]) > 3600)
   {
      SendTelegramMessage("🚨 <b>" + sym + " Volume Spike!</b>\nRVOL M15: " + DoubleToString(rvol_m15, 2) +
                          "x | Price: " + DoubleToString(bid, digits));
      G_LastVolAlert[idx] = TimeCurrent();
   }
   if(G_LastChoch[idx] != 0.0 && atr_m15 > 0.0 && MathAbs(mic_choch - G_LastChoch[idx]) > atr_m15)
   {
      if((TimeCurrent() - G_LastChochAlert[idx]) > 3600)
      {
         SendTelegramMessage("⚠️ <b>" + sym + " ChoCh Shift!</b>\nNew: " + DoubleToString(mic_choch, digits) +
                             " | Price: " + DoubleToString(bid, digits));
         G_LastChochAlert[idx] = TimeCurrent();
      }
   }
   G_LastChoch[idx] = mic_choch;

   double fut_price = 0.0, basis_usd = 0.0;
   if(StringFind(sym, "XAU") >= 0)
   {
      if(Inp_GoldFut_Symbol != "" && SymbolInfoDouble(Inp_GoldFut_Symbol, SYMBOL_BID) > 0)
      {
         fut_price = SymbolInfoDouble(Inp_GoldFut_Symbol, SYMBOL_BID);
         basis_usd = fut_price - bid;
      }
      else
      {
         basis_usd = Inp_GoldBasisFallback;
         fut_price = bid + basis_usd;
      }
   }

   string j = "{";
   j += "\"meta\":{";
   j += "\"symbol\":\"" + sym + "\",";
   j += "\"digits\":" + IntegerToString(digits) + ",";
   j += "\"market_session\":\"" + session + "\",";
   j += "\"in_killzone\":" + (in_kz ? "true" : "false") + ",";
   j += "\"bid\":" + DoubleToString(bid, digits) + ",";
   j += "\"ask\":" + DoubleToString(ask, digits) + ",";
   j += "\"spread_points\":" + IntegerToString(spread_pts) + ",";
   j += "\"spread_usd\":" + DoubleToString(spread_usd, digits) + ",";
   j += "\"spread_status\":\"" + spread_status + "\",";
   j += "\"daily_change_percent\":" + DoubleToString(daily_chg, 2) + ",";
   j += "\"contract_specs\":{";
   j += "\"contract_size\":" + DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 2) + ",";
   j += "\"tick_value\":" + DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 4) + ",";
   j += "\"tick_size\":" + DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), digits) + ",";
   j += "\"min_lot\":" + DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 2) + ",";
   j += "\"lot_step\":" + DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 2);
   j += "}},";

   j += "\"basis\":{";
   j += "\"futures_price\":" + DoubleOrNull(fut_price, digits) + ",";
   j += "\"basis_spread_usd\":" + (fut_price > 0 ? DoubleToString(basis_usd, 2) : "null");
   j += "},";

   j += "\"quant_regime\":{";
   j += "\"hurst_m15\":" + DoubleToString(hurst_m15, 3) + ",";
   j += "\"hurst_h1\":" + DoubleToString(hurst_h1, 3) + ",";
   j += "\"detected_regime\":\"" + regime + "\",";
   j += "\"atr_14\":{\"M5\":" + DoubleToString(atr_m5, digits) + ",\"M15\":" + DoubleToString(atr_m15, digits) +
        ",\"H1\":" + DoubleToString(atr_h1, digits) + ",\"D1\":" + DoubleToString(atr_d1, digits) + "},";
   j += "\"adr_14\":" + DoubleToString(adr, digits) + ",";
   j += "\"daily_range_exhaustion_pct\":" + DoubleToString(exh_pct, 2);
   j += "},";

   j += GetQuantIndicatorsAndCorr(sym, digits);

   j += "\"microstructure_volume\":{";
   j += "\"poc_level\":" + DoubleOrNull(poc, digits) + ",";
   j += "\"va_high\":" + DoubleOrNull(vaH, digits) + ",";
   j += "\"va_low\":" + DoubleOrNull(vaL, digits) + ",";
   j += "\"daily_vwap\":" + DoubleOrNull(vwap, digits) + ",";
   j += "\"vwap_upper_1sd\":" + DoubleOrNull(sd1_u, digits) + ",";
   j += "\"vwap_lower_1sd\":" + DoubleOrNull(sd1_d, digits) + ",";
   j += "\"vwap_upper_2sd\":" + DoubleOrNull(sd2_u, digits) + ",";
   j += "\"vwap_lower_2sd\":" + DoubleOrNull(sd2_d, digits) + ",";
   j += "\"vwap_slope\":\"" + vwap_slope + "\",";
   j += "\"synthetic_cvd_session\":" + IntegerToString(synth_cvd_session) + ",";
   j += "\"synthetic_cvd_m15\":" + IntegerToString(synth_cvd_m15) + ",";
   j += "\"rvol_m15\":" + DoubleToString(rvol_m15, 2) + ",";
   j += "\"dom_buy_pressure_pct\":" + GetDOMBuyPressure(sym) + ",";
   j += "\"state\":\"" + vol_state + "\"";
   j += "},";

   j += "\"smc_structure\":{";
   j += "\"macro\":{\"tf\":\"" + EnumToString(G_TF_Macro) + "\",\"trend_bias\":\"" + mac_bias + "\"," +
        "\"bos_level\":" + DoubleToString(mac_bos, digits) + ",\"choch_level\":" + DoubleToString(mac_choch, digits) + "," +
        "\"nearest_fvg_bullish\":" + FormatZoneJson(mac_fvg_b, digits) + "," +
        "\"nearest_fvg_bearish\":" + FormatZoneJson(mac_fvg_s, digits) + "," +
        "\"nearest_ob_bullish\":"  + FormatZoneJson(mac_ob_b, digits) + "," +
        "\"nearest_ob_bearish\":"  + FormatZoneJson(mac_ob_s, digits) + "},";
   j += "\"micro\":{\"tf\":\"" + EnumToString(G_TF_Micro) + "\",\"trend_bias\":\"" + mic_bias + "\"," +
        "\"bos_level\":" + DoubleToString(mic_bos, digits) + ",\"choch_level\":" + DoubleToString(mic_choch, digits) + "," +
        "\"nearest_fvg_bullish\":" + FormatZoneJson(mic_fvg_b, digits) + "," +
        "\"nearest_fvg_bearish\":" + FormatZoneJson(mic_fvg_s, digits) + "," +
        "\"nearest_ob_bullish\":"  + FormatZoneJson(mic_ob_b, digits) + "," +
        "\"nearest_ob_bearish\":"  + FormatZoneJson(mic_ob_s, digits) + "}";
   j += "},";

   j += "\"liquidity_pools\":{";
   j += "\"ny_midnight_open\":" + DoubleOrNull(mid_open, digits) + ",";
   j += "\"ny_830_am_open\":" + DoubleOrNull(ny_open, digits) + ",";
   j += "\"pdh\":" + FormatLiqJson(pdh, digits) + ",";
   j += "\"pdl\":" + FormatLiqJson(pdl, digits) + ",";
   j += "\"pwh\":" + FormatLiqJson(pwh, digits) + ",";
   j += "\"pwl\":" + FormatLiqJson(pwl, digits) + ",";
   j += "\"asian_high\":" + FormatLiqJson(ah, digits) + ",";
   j += "\"asian_low\":" + FormatLiqJson(al, digits) + ",";
   j += "\"london_high\":" + FormatLiqJson(lh, digits) + ",";
   j += "\"london_low\":" + FormatLiqJson(ll, digits);
   j += "},";

   j += "\"candles_data\":{";
   j += "\"D1\":"  + GetCandlesJSON(sym, PERIOD_D1,  Inp_Bars_D1,  digits) + ",";
   j += "\"H4\":"  + GetCandlesJSON(sym, PERIOD_H4,  Inp_Bars_H4,  digits) + ",";
   j += "\"H1\":"  + GetCandlesJSON(sym, PERIOD_H1,  Inp_Bars_H1,  digits) + ",";
   j += "\"M15\":" + GetCandlesJSON(sym, PERIOD_M15, Inp_Bars_M15, digits) + ",";
   j += "\"M5\":"  + GetCandlesJSON(sym, PERIOD_M5,  Inp_Bars_M5,  digits);
   j += "}}";

   return j;
}

//====================================================================
//                       MASTER EXPORT PIPELINE
//====================================================================
void ExportAllCommodities()
{
   ulong t0 = GetTickCount();
   datetime utc_now = TimeGMT();
   int utc_offset_hr = (int)MathRound((double)(TimeCurrent() - utc_now) / 3600.0);

   double dxy_chg = 0.0;
   double dxy_bid = GetLiveDXY(dxy_chg);

   double xau_p = 0.0, xag_p = 0.0;
   for(int i = 0; i < G_SymbolCount; i++)
   {
      if(StringFind(G_Symbols[i], "XAU") >= 0) xau_p = SymbolInfoDouble(G_Symbols[i], SYMBOL_BID);
      if(StringFind(G_Symbols[i], "XAG") >= 0) xag_p = SymbolInfoDouble(G_Symbols[i], SYMBOL_BID);
   }
   double xau_xag_ratio = (xau_p > 0 && xag_p > 0) ? (xau_p / xag_p) : 0.0;

   string style_str = (Inp_Trade_Style == STYLE_SCALP) ? "Scalping" :
                      (Inp_Trade_Style == STYLE_DAYTRADE) ? "DayTrading" : "Swing";

   string json = "{";
   json += "\"schema_version\":\"2.1\",";
   json += "\"broker\":\"" + AccountInfoString(ACCOUNT_COMPANY) + "\",";
   json += "\"utc_timestamp\":\"" + FormatISO8601UTC(utc_now) + "\",";
   json += "\"server_utc_offset_hours\":" + IntegerToString(utc_offset_hr) + ",";
   json += "\"target_strategy\":\"" + style_str + "\",";

   json += "\"intermarket\":{";
   json += "\"dxy_price\":" + DoubleOrNull(dxy_bid, 3) + ",";
   json += "\"dxy_change_pct\":" + (dxy_bid > 0 ? DoubleToString(dxy_chg, 2) : "null") + ",";
   json += "\"xau_xag_ratio\":" + DoubleOrNull(xau_xag_ratio, 2);
   json += "},";

   json += "\"commodities\":{";
   for(int i = 0; i < G_SymbolCount; i++)
   {
      json += "\"" + G_Symbols[i] + "\":" + BuildCommodityJSON(i);
      if(i < G_SymbolCount - 1) json += ",";
   }
   json += "},";

   double proc_sec = (double)(GetTickCount() - t0) / 1000.0;
   json += "\"diagnostics\":{\"processing_time_sec\":" + DoubleToString(proc_sec, 3) + ",\"status\":\"OK\"}";
   json += "}";

   if(Inp_EnableWebhook)
      PostWebhookPayload(json);

   if((TimeCurrent() - G_LastFileWrite) >= Inp_DriveSyncSec || G_LastFileWrite == 0)
   {
      string tempFile = "temp_" + Inp_FileName;
      int handle = FileOpen(tempFile, FILE_WRITE|FILE_TXT|FILE_ANSI, 0, CP_UTF8);
      if(handle != INVALID_HANDLE)
      {
         FileWriteString(handle, json);
         FileClose(handle);
         if(FileIsExist(Inp_FileName)) FileDelete(Inp_FileName);
         FileMove(tempFile, 0, Inp_FileName, 0);
         G_LastFileWrite = TimeCurrent();
      }
      else
      {
         Print("[File Error] Cannot write ", tempFile, " | Error: ", GetLastError());
      }
   }
}
