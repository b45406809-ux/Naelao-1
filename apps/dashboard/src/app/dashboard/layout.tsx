"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar, TopBar, useTheme, type SidebarNavEntry } from "@naelao/ui";
import { useAuth } from "@/lib/auth-provider";
import { getNaelaoLaunchpadDashboard } from "@/lib/api";

const NAV_ITEMS: SidebarNavEntry[] = [
  { key: "dashboard", icon: "home", label: "Overview" },
  { key: "launchpad", icon: "spaces", label: "Launchpad" },
  { key: "settings", icon: "settings", label: "Settings" },
];

function activeKeyFor(pathname: string | null): string {
  if (pathname?.startsWith("/dashboard/products")) return "launchpad";
  if (pathname?.startsWith("/dashboard/settings") || pathname?.startsWith("/dashboard/api-keys")) return "settings";
  return "dashboard";
}

const ROUTE_FOR_KEY: Record<string, string> = {
  dashboard: "/dashboard",
  launchpad: "/dashboard/products",
  settings: "/dashboard/settings",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isHydrated, claims, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useTheme();
  const [teamAccess, setTeamAccess] = useState<"checking" | "allowed" | "denied">("checking");

  useEffect(() => {
    if (isHydrated && !isAuthenticated) router.replace("/login");
  }, [isHydrated, isAuthenticated, router]);

  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;
    let active = true;
    getNaelaoLaunchpadDashboard()
      .then(() => { if (active) setTeamAccess("allowed"); })
      .catch(() => { if (active) setTeamAccess("denied"); });
    return () => { active = false; };
  }, [isHydrated, isAuthenticated]);

  if (!isHydrated || !isAuthenticated || teamAccess === "checking") {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</span>
    </div>;
  }

  if (teamAccess === "denied") {
    return <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-gray-900">Naelao team access required</h1>
        <p className="text-sm text-gray-500 mt-2">This dashboard is reserved for the Naelao team.</p>
        <button type="button" onClick={logout} className="mt-5 px-4 py-2 rounded-lg border border-gray-200 text-sm">Log out</button>
      </div>
    </div>;
  }

  return (
    <div id="app">
      <Sidebar
        brandName="Naelao"
        activeKey={activeKeyFor(pathname)}
        onNavigate={(key) => router.push(ROUTE_FOR_KEY[key] ?? "/dashboard")}
        primaryNav={NAV_ITEMS}
      />
      <div id="main">
        <TopBar left={<span style={{ fontSize: 13, color: "var(--text2)" }}>Naelao Dashboard</span>}>
          <span style={{ fontSize: 13, color: "var(--text2)" }}>{claims?.email ?? ""}</span>
          <button type="button" onClick={logout} className="btn btn-secondary">Logout</button>
        </TopBar>
        <main style={{ padding: 24, overflow: "auto" }}>{children}</main>
      </div>
    </div>
  );
}
