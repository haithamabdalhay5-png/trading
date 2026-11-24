import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MIRAS AI | تحليل XAUUSD",
  description: "منصة MIRAS AI التحليلية الآمنة للذهب XAUUSD بدون تنفيذ صفقات.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
