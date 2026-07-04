"use client";

// The manifest-driven Product Shell chrome (sidebar + top bar), reused by every view under
// /p/[slug]/(shell)/*. Shell v1 scope (per the phased plan): core views (Home, Spaces, Assistant,
// Projects, Agents, Knowledge, Settings) + Workflows. Marketplace/Analytics/Explore are deferred.
//
// Nav item set is fixed (matches the launchpad-6 mockup) and filtered by the manifest's
// `hidden_core_items` — NOT driven by `ui.sidebar_items`, which is the BUILDER dashboard's own
// operator-shell config (Revenue/Orders/Customers/...), a structurally different surface (see
// CLAUDE.md item #30, Phase 6 scope correction).

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar, Toast, useToast, useTheme, type SidebarNavEntry } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { getShellManifest, getMe, type ShellManifest, type ProductUserMe } from "@/lib/api";

const DEFAULT_PRIMARY_NAV: SidebarNavEntry[] = [
  { key: "home", icon: "home", label: "Home" },
  { key: "spaces", icon: "spaces", label: "Spaces" },
  { key: "assistant", icon: "assistant", label: "Assistant" },
  { key: "projects", icon: "projects", label: "Projects" },
];

const DEFAULT_MORE_NAV: SidebarNavEntry[] = [
  { key: "agents", icon: "agents", label: "Agents" },
  { key: "knowledge", icon: "knowledge", label: "Knowledge" },
  { key: "workflows", icon: "workflows", label: "Workflows" },
  { key: "settings", icon: "settings", label: "Settings" },
];

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  const product = useProduct();
  const { session, isHydrated, isAuthenticated } = useProductAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { toast, show } = useToast();
  useTheme();

  const [manifest, setManifest] = React.useState<ShellManifest | null>(null);
  const [me, setMe] = React.useState<ProductUserMe | null>(null);

  React.useEffect(() => {
    if (isHydrated && !isAuthenticated) {
      router.replace(`/p/${product.slug}/login`);
    }
  }, [isHydrated, isAuthenticated, product.slug, router]);

  React.useEffect(() => {
    if (!session) return;
    const creds = { sessionToken: session.session_token, endUserId: session.end_user_id };
    getShellManifest(product.space_id, creds).then(setManifest).catch(() => show("Couldn't load workspace"));
    getMe(product.space_id, creds).then(setMe).catch(() => {});
  }, [session, product.space_id, product.slug, show]);

  if (!isHydrated || !isAuthenticated) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  const hidden = new Set(manifest?.ui.hidden_core_items ?? []);
  const primaryNav = DEFAULT_PRIMARY_NAV.filter((item) => !hidden.has(item.key));
  const moreNav = DEFAULT_MORE_NAV.filter((item) => !hidden.has(item.key));
  const activeKey = pathname?.split("/").filter(Boolean)[2] ?? "home";

  return (
    <div id="app">
      <Sidebar
        brandName={manifest?.space_name ?? product.product_name}
        activeKey={activeKey}
        onNavigate={(key) => router.push(key === "home" ? `/p/${product.slug}` : `/p/${product.slug}/${key}`)}
        primaryNav={primaryNav}
        moreNav={moreNav}
        onNewThread={() => router.push(`/p/${product.slug}`)}
        spaceSwitcher={{
          current: { id: product.space_id, name: manifest?.space_name ?? product.product_name, meta: me ? `${me.credits_balance} credits` : "…" },
          entries: [
            { id: product.space_id, name: manifest?.space_name ?? product.product_name, meta: me ? `${me.credits_balance} credits` : "…" },
          ],
          open: false,
          onToggle: () => show("Business switching lands in a later phase"),
          onSwitch: () => {},
          canCreate: false,
        }}
      />
      <div id="main">{children}</div>
      <Toast toast={toast} />
    </div>
  );
}
