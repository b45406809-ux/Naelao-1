import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Naelao",
  description: "Sign in to your product",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
