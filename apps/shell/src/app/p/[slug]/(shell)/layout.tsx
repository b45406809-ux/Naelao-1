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
import { ActiveSpaceProvider, useActiveSpace } from "@/lib/active-space-context";
import {
  getShellManifest,
  getMe,
  listProjects,
  listThreads,
  createThread,
  listMyBusinesses,
  type ShellManifest,
  type ProductUserMe,
  type Project,
  type ThreadSummary,
  type Business,
} from "@/lib/api";

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
  return (
    <ActiveSpaceProvider productSpaceId={product.space_id}>
      <ShellLayoutInner>{children}</ShellLayoutInner>
    </ActiveSpaceProvider>
  );
}

function ShellLayoutInner({ children }: { children: React.ReactNode }) {
  const product = useProduct();
  const { activeSpaceId, setActiveSpace } = useActiveSpace();
  const { session, isHydrated, isAuthenticated } = useProductAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { toast, show } = useToast();
  useTheme();

  const [manifest, setManifest] = React.useState<ShellManifest | null>(null);
  const [me, setMe] = React.useState<ProductUserMe | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [businesses, setBusinesses] = React.useState<Business[]>([]);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);

  React.useEffect(() => {
    if (isHydrated && !isAuthenticated) {
      router.replace(`/p/${product.slug}/login`);
    }
  }, [isHydrated, isAuthenticated, product.slug, router]);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  // The core re-scope fix: every data call below reads `activeSpaceId` (the switched business,
  // or the product root by default) — NOT `product.space_id` directly. Previously these were all
  // pinned to the product root regardless of the switcher, so switching a business let you
  // *administer* it (via /spaces/:id) but never actually *work inside* it.
  React.useEffect(() => {
    if (!creds) return;
    getShellManifest(activeSpaceId, creds).then(setManifest).catch(() => show("Couldn't load workspace"));
    getMe(activeSpaceId, creds).then(setMe).catch(() => {});
    listProjects(activeSpaceId, creds).then(setProjects).catch(() => {});
    listThreads(activeSpaceId, creds).then((all) => setThreads(all.slice(0, 3))).catch(() => {});
    // The switcher's own entry list is always the product-root's businesses, regardless of which
    // one is currently active — deliberately NOT activeSpaceId.
    listMyBusinesses(product.space_id, creds).then(setBusinesses).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, activeSpaceId, product.space_id, product.slug]);

  async function handleNewThread() {
    if (!creds) return;
    try {
      const created = await createThread(activeSpaceId, creds, { title: "New thread" });
      router.push(`/p/${product.slug}/threads/${created.id}`);
    } catch {
      show("Failed to create thread");
    }
  }

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

  const currentEntry = activeSpaceId === product.space_id
    ? { id: product.space_id, name: manifest?.space_name ?? product.product_name, meta: me ? `${me.credits_balance} credits` : "…" }
    : {
        id: activeSpaceId,
        name: businesses.find((b) => b.id === activeSpaceId)?.name ?? manifest?.space_name ?? "Business",
        meta: me ? `${me.credits_balance} credits` : "…",
      };

  return (
    <div id="app">
      <Sidebar
        brandName={manifest?.space_name ?? product.product_name}
        activeKey={activeKey}
        onNavigate={(key) => router.push(key === "home" ? `/p/${product.slug}` : `/p/${product.slug}/${key}`)}
        primaryNav={primaryNav}
        moreNav={moreNav}
        onNewThread={handleNewThread}
        projects={projects.map((p) => ({ id: p.id, label: p.name }))}
        onOpenProject={(id) => router.push(`/p/${product.slug}/projects/${id}`)}
        onNewProject={() => router.push(`/p/${product.slug}/projects`)}
        threads={threads.map((t) => ({ id: t.id, label: t.title ?? "Untitled thread" }))}
        onOpenThread={(id) => router.push(`/p/${product.slug}/threads/${id}`)}
        onMoreThreads={() => router.push(`/p/${product.slug}/threads`)}
        spaceSwitcher={{
          current: currentEntry,
          entries: [
            { id: product.space_id, name: product.product_name, meta: "Product" },
            ...businesses.map((b) => ({ id: b.id, name: b.name, meta: `${b.role} · ${b.space_status}` })),
          ],
          open: switcherOpen,
          onToggle: () => setSwitcherOpen((v) => !v),
          onSwitch: (id) => {
            setSwitcherOpen(false);
            if (id === product.space_id) {
              setActiveSpace(product.space_id, product.product_name);
            } else {
              const business = businesses.find((b) => b.id === id);
              setActiveSpace(id, business?.name ?? null);
            }
            // Re-scoping happens via context — land on Home, now scoped to the switched space.
            // The business's own admin/management page is reached from the Spaces list, not here.
            router.push(`/p/${product.slug}`);
          },
          onCreate: () => {
            setSwitcherOpen(false);
            router.push(`/p/${product.slug}/spaces`);
          },
          canCreate: manifest?.membership_model !== "team",
        }}
      />
      <div id="main">
        {me && !me.email_verified && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "8px 16px",
              background: "var(--accent-soft, #fef3c7)",
              borderBottom: "1px solid var(--border)",
              fontSize: 12.5,
            }}
          >
            <span>
              Verify your email to unlock your free starting credits
              {me.credits_balance === 0 ? " — your account has 0 credits until then." : "."}
            </span>
            <button
              type="button"
              onClick={() => router.push(`/p/${product.slug}/verify-email`)}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent)",
                fontWeight: 600,
                fontSize: 12.5,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Verify now
            </button>
          </div>
        )}
        {children}
      </div>
      <Toast toast={toast} />
    </div>
  );
}
