import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-provider";

export const metadata: Metadata = {
  title: "Naelao Dashboard",
  description: "Naelao Builder Dashboard — create and manage AI-powered Spaces",
  referrer: "no-referrer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased" style={{ background: "var(--bg)", color: "var(--text)" }}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
