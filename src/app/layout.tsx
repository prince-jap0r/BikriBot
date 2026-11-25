import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "BikriBot – Facebook Page Sales AI",
  description: "Multi-tenant Facebook Messenger sales agent with Bangla chat, tool-calling and order capture.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="bn">
      <body className="bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
