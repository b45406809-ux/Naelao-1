"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar, TopBar, Badge, useTheme, type SidebarNavEntry } from "@naelao/ui";
import { useAuth } from "@/lib/auth-provider";

// Phase D reskin (§A1.17): adopts @naelao/ui's Sidebar/TopBar instead of a hand-rolled Tailwind
// nav — Sidebar's projects/threads/spaceSwitcher sections are all optional and simply don't
// render when omitted, so it's a clean fit for this admin shell without dragging in end-user
// chat-shell concepts. IA restructured per the phased plan: nav collapses to Dashboard / Spaces
// (the builder's products — same URL, relabeled since "Products" and "Spaces" meant the same
// thing to a builder) / Clients (kept, unlike the plan's literal 3-item list — dropping real,
// working reseller portfolio UI would be a regression the plan never asked for) / Settings.
// "SpaceTypes" is gone — it called a dead route (`GET /spacetypes`, no worker implements it) and
// linked to detail/edit pages that never existed; the wizard's own Template Gallery step already
// covers SpaceType selection via the real `GET /builder/space-types`. The legacy
// `/dashboard/spaces` (raw generic Space CRUD + its per-space admin tool pages — KB, webhooks,
// connectors, credentials, commerce, eval, onboarding, sessions) is NOT deleted (those sub-pages
// are real, working per-space tools nothing else replaces yet) but is deliberately no longer
// promoted in top nav — a builder's canonical "space" creation path is now the Products wizard.

const NAV_ITEMS: SidebarNavEntry[] = [
  { key: "dashboard", icon: "home", label: "Dashboard" },
  { key: "products", icon: "spaces", label: "Spaces" },
  { key: "clients", icon: "explore", label: "Clients" },
  { key: "settings", icon: "settings", label: "Settings" },
];

function activeKeyFor(pathname: string | null): string {
  if (!pathname || pathname === "/dashboard") return "dashboard";
  if (pathname.startsWith("/dashboard/products")) return "products";
  if (pathname.startsWith("/dashboard/clients")) return "clients";
  if (pathname.startsWith("/dashboard/settings") || pathname.startsWith("/dashboard/api-keys")) return "settings";
  return "dashboard";
}

const ROUTE_FOR_KEY: Record<string, string> = {
  dashboard: "/dashboard",
  products: "/dashboard/products",
  clients: "/dashboard/clients",
  settings: "/dashboard/settings",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isHydrated, claims, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useTheme();

  useEffect(() => {
    if (isHydrated && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isHydrated, isAuthenticated, router]);

  if (!isHydrated || !isAuthenticated) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  const planTier = (claims as { plan_tier?: string } | null)?.plan_tier ?? "free";

  return (
    <div id="app">
      <Sidebar
        brandName="Naelao"
        activeKey={activeKeyFor(pathname)}
        onNavigate={(key) => router.push(ROUTE_FOR_KEY[key] ?? "/dashboard")}
        primaryNav={NAV_ITEMS}
      />
      <div id="main">
        <TopBar left={<span style={{ fontSize: 13, color: "var(--text2)" }}>Org: {claims?.tid ?? "—"}</span>}>
          <Badge color={planTier === "free" ? "blue" : "purple"}>{planTier} plan</Badge>
          <span style={{ fontSize: 13, color: "var(--text2)" }}>{claims?.email ?? ""}</span>
          <button type="button" onClick={logout} className="btn btn-secondary">
            Logout
          </button>
        </TopBar>
        <main style={{ padding: 24, overflow: "auto" }}>{children}</main>
      </div>
    </div>
  );
}
