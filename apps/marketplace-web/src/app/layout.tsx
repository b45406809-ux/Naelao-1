import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Naelao Marketplace — Discover AI Agent Templates",
  description: "Browse, preview, and fork AI agent space templates built by the community.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
            <a href="/" className="flex items-center gap-2 font-bold text-brand-700 text-lg">
              <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
                </svg>
              </div>
              Marketplace
            </a>
            <span className="text-gray-300 text-lg">|</span>
            <nav className="flex gap-4 text-sm text-gray-600">
              <a href="/" className="hover:text-brand-700">All templates</a>
              <a href="/categories/customer-support" className="hover:text-brand-700">Support</a>
              <a href="/categories/dev-tools" className="hover:text-brand-700">Dev Tools</a>
            </nav>
            <div className="ml-auto">
              <a href={process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://app.naelao.com"} className="text-sm text-brand-600 font-semibold hover:text-brand-800">
                Open Dashboard →
              </a>
            </div>
          </div>
        </header>
        <main>{children}</main>
        <footer className="border-t border-gray-200 mt-16 py-8 text-center text-xs text-gray-400">
          © {new Date().getFullYear()} Naelao. All rights reserved.
        </footer>
      </body>
    </html>
  );
}
