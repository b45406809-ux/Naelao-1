"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";

interface NavItem {
  label: string;
  href: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: "◻" },
  { label: "SpaceTypes", href: "/dashboard/spacetypes", icon: "◈" },
  { label: "Spaces", href: "/dashboard/spaces", icon: "⬡" },
  { label: "Settings", href: "/dashboard/settings", icon: "⚙" },
];

const PLAN_BADGE_COLORS: Record<string, string> = {
  free: "bg-gray-100 text-gray-600",
  growth: "bg-blue-100 text-blue-700",
  business: "bg-purple-100 text-purple-700",
  enterprise: "bg-yellow-100 text-yellow-700",
};

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        isActive
          ? "bg-brand-100 text-brand-700"
          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
      }`}
    >
      <span className="text-base">{item.icon}</span>
      {item.label}
    </Link>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, claims, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, router]);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  const planTier = (claims as { plan_tier?: string } | null)?.plan_tier ?? "free";
  const planBadge = PLAN_BADGE_COLORS[planTier] ?? PLAN_BADGE_COLORS["free"]!;

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col">
        {/* Logo */}
        <div className="p-5 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center">
              <span className="text-white text-sm font-bold">N</span>
            </div>
            <span className="font-bold text-gray-900">Naelao</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);
            return <NavLink key={item.href} item={item} isActive={isActive} />;
          })}
        </nav>

        {/* User info at bottom */}
        <div className="p-4 border-t border-gray-200">
          <div className="text-xs text-gray-500 truncate mb-1">
            {claims?.email ?? ""}
          </div>
          <div className="flex items-center justify-between">
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${planBadge}`}
            >
              {planTier}
            </span>
            <button
              type="button"
              onClick={logout}
              className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500">
              Organization:{" "}
              <span className="font-medium text-gray-700">
                {claims?.tid ?? "—"}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">{claims?.email ?? ""}</span>
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-semibold capitalize ${planBadge}`}
            >
              {planTier} plan
            </span>
            <button
              type="button"
              onClick={logout}
              className="text-sm text-gray-500 hover:text-gray-900 transition-colors border border-gray-200 rounded-lg px-3 py-1.5 hover:border-gray-300"
            >
              Logout
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
