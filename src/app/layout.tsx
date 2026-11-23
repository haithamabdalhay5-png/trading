import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "مِرصد | منصة مراقبة التداول",
  description: "لوحة مراقبة آمنة لتغذية بيانات MT5 وتحليل الأسواق — نسخة تأسيسية.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
