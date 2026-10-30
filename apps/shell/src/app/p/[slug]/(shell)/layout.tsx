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
import { PresentationProfileProvider } from "@/lib/presentation-profile";
import {
  getShellManifest,
  getMe,
  listProjects,
  listSessions,
  listThreads,
  listMySpaces,
  listAllApprovals,
  type ShellManifest,
  type ProductUserMe,
  type Project,
  type SessionSummary,
  type ThreadSummary,
  type SpaceSummary,
} from "@/lib/api";

// No "Home" entry: starting a conversation is what the "new session" button does, and having
// both a button and a nav item pointing at the same surface just made the sidebar ambiguous.
//
// "Dashboard" (formerly "Assistant") is a merged space dashboard + assistant dashboard for
// whichever space is currently active — it's the first thing worth seeing, so it leads the list,
// ahead of Discover.
/** How many recent conversations the left sidebar keeps. The sidebar collapses past its own
 *  "show more" threshold anyway, so this is the pool that list draws from — five was small enough
 *  that a couple of days' work pushed a conversation out of reach without ever going to /sessions. */
const SIDEBAR_RECENT_SESSIONS = 15;
const SIDEBAR_RECENT_PROJECT_THREADS = 15;

const DEFAULT_PRIMARY_NAV: SidebarNavEntry[] = [
  { key: "dashboard", icon: "assistant", label: "Dashboard" },
  { key: "bots", icon: "agents", label: "Bots" },
  { key: "spaces", icon: "spaces", label: "Discover" },
  { key: "projects", icon: "projects", label: "Projects" },
];

const DEFAULT_MORE_NAV: SidebarNavEntry[] = [
  // Approvals sits in the primary nav below, not here, and only once something is actually
  // waiting: a permanently-visible empty inbox trains people to ignore it, which defeats the one
  // job it has.
  { key: "agents", icon: "agents", label: "Workers" },
  { key: "extensions", icon: "marketplace", label: "Extensions" },
  { key: "analytics", icon: "analytics", label: "Analytics" },
  { key: "knowledge", icon: "knowledge", label: "Knowledge" },
  // Real third-party apps (Composio/Pipedream-routed + bespoke OAuth/manual-key) the assistant
  // and project agents can reach over MCP — see connectors/page.tsx.
  { key: "connectors", icon: "marketplace", label: "Connectors" },
  { key: "workflows", icon: "workflows", label: "Workflows" },
  // What the assistant/its agents want you to know about (an approval opened, a run failed, a
  // connector needs setup) — distinct from Approvals (which needs a decision, not just a look).
  // No dedicated bell icon in this design system yet; "explore" is the closest unused glyph.
  { key: "notifications", icon: "explore", label: "Notifications" },
  { key: "settings", icon: "settings", label: "Settings" },
];

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  const product = useProduct();
  return (
    <ActiveSpaceProvider productSpaceId={product.space_id}>
      <PresentationProfileProvider><ShellLayoutInner>{children}</ShellLayoutInner></PresentationProfileProvider>
    </ActiveSpaceProvider>
  );
}

function ShellLayoutInner({ children }: { children: React.ReactNode }) {
  const product = useProduct();
  const { activeSpaceId, setActiveSpace, setSupportContact, isHydrated: activeSpaceHydrated } = useActiveSpace();
  const { session, isHydrated, isAuthenticated } = useProductAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { toast, show } = useToast();
  useTheme();

  const [manifest, setManifest] = React.useState<ShellManifest | null>(null);
  const [me, setMe] = React.useState<ProductUserMe | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [projectThreads, setProjectThreads] = React.useState<ThreadSummary[]>([]);
  const [spaces, setSpaces] = React.useState<SpaceSummary[]>([]);
  const [spacesLoaded, setSpacesLoaded] = React.useState(false);
  // How many actions an agent has paused on, waiting for this person. A parked action is
  // invisible otherwise — the agent carries on with the rest of the task, which is exactly what
  // makes it easy to miss that something needs a decision.
  const [pendingApprovals, setPendingApprovals] = React.useState(0);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  // Below the mockup's 900px breakpoint the left sidebar is an off-canvas drawer. The thread
  // header owns its hamburger on small screens; keeping the control beside the conversation title
  // avoids spending a second full-width row on a mobile-only shell header.
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  React.useEffect(() => { setMobileNavOpen(false); }, [pathname]);
  React.useEffect(() => {
    const toggle = () => setMobileNavOpen((current) => !current);
    window.addEventListener("naelao:toggle-mobile-nav", toggle);
    return () => window.removeEventListener("naelao:toggle-mobile-nav", toggle);
  }, []);
  // The workspace opens with the global navigation collapsed so the active canvas gets the
  // attention. Keep the choice per product, while preserving the compact default for new users.
  const sidebarKey = `naelao-sidebar-collapsed:${product.slug}`;
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(true);
  React.useEffect(() => {
    const stored = window.localStorage.getItem(sidebarKey);
    if (stored !== null) setSidebarCollapsed(stored !== "0");
  }, [sidebarKey]);
  const toggleSidebar = React.useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(sidebarKey, next ? "1" : "0");
      return next;
    });
  }, [sidebarKey]);
  // Cookie consent: shown only when the product's cookiePolicy is "third_party" and the user
  // hasn't already accepted in this browser. localStorage key is per-product-slug so accepting
  // on one product doesn't silently grant consent for another.
  const CONSENT_KEY = `naelao-cookie-consent:${product.slug}`;
  const [cookieConsentPending, setCookieConsentPending] = React.useState(false);
  React.useEffect(() => {
    if (manifest?.legal.cookie_policy === "third_party") {
      setCookieConsentPending(typeof localStorage !== "undefined" && !localStorage.getItem(CONSENT_KEY));
    }
  }, [manifest?.legal.cookie_policy, CONSENT_KEY]);
  function acceptCookies() {
    if (typeof localStorage !== "undefined") localStorage.setItem(CONSENT_KEY, "1");
    setCookieConsentPending(false);
  }

  React.useEffect(() => {
    if (isHydrated && !isAuthenticated) {
      router.replace(`/p/${product.slug}/login`);
    }
  }, [isHydrated, isAuthenticated, product.slug, router]);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  // Every data call below reads `activeSpaceId` (the selected Space,
  // or the product root by default) — NOT `product.space_id` directly. Previously these were all
  // pinned to the product root regardless of the switcher, so switching a space let you
  // access it (via /spaces/:id) but never actually work inside it.
  React.useEffect(() => {
    if (!creds) return;
    getShellManifest(activeSpaceId, creds).then((m) => {
      setManifest(m);
      setSupportContact(m.legal?.support_contact ?? null);
    }).catch(() => show("Couldn't load workspace"));
    // …with one deliberate exception: `me` is the PERSON, not the workspace. A ProductUserDO is
    // one instance per (root Space × endUserId), so profile lookup stays on the product root.
    getMe(product.space_id, creds).then(setMe).catch(() => {});
    listProjects(activeSpaceId, creds).then(setProjects).catch(() => {});
    // The switcher's own entry list is always the product-root's Spaces, regardless of which
    // one is currently active — deliberately NOT activeSpaceId.
    listMySpaces(product.space_id, creds)
      .then((items) => { setSpaces(items); setSpacesLoaded(true); })
      .catch(() => setSpacesLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, activeSpaceId, product.space_id, product.slug]);

  // Keep both recent conversation groups live while the shell stays mounted. Chat dispatches this
  // event immediately after lazy session creation, so the new session appears without a reload;
  // the project-thread list is refreshed at the same time because a newly opened project thread
  // should be available in the adjacent group immediately as well.
  const refreshSidebarConversations = React.useCallback(() => {
    if (!session) return;
    const sidebarCreds = { sessionToken: session.session_token, endUserId: session.end_user_id };
    listSessions(activeSpaceId, sidebarCreds, SIDEBAR_RECENT_SESSIONS).then(setSessions).catch(() => {});
    listThreads(activeSpaceId, sidebarCreds)
      .then(setProjectThreads)
      .catch(() => {});
  }, [activeSpaceId, session?.session_token, session?.end_user_id]);

  React.useEffect(() => {
    refreshSidebarConversations();
    const onSessionCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ spaceId?: string }>).detail;
      if (!detail?.spaceId || detail.spaceId === activeSpaceId) refreshSidebarConversations();
    };
    window.addEventListener("naelao:session-created", onSessionCreated);
    return () => window.removeEventListener("naelao:session-created", onSessionCreated);
  }, [activeSpaceId, refreshSidebarConversations]);

  // Approvals are scoped to a Space (HITLApprovalDO is addressed `hitl:{spaceId}`), so check the
  // root and each Space in the switcher rather than only the currently selected one. An approval
  // parked under a Space you aren't currently
  // viewing was completely invisible: no badge, nothing on the Approvals page, no way to find it
  // short of switching to every space one at a time and hoping. Now checked across every
  // Space the person belongs to, once the list has loaded — not just the active one.
  // Separate effect from the one above (rather than folded into it) because it genuinely needs
  // `spaces` to be populated first, not just kicked off in parallel with it.
  React.useEffect(() => {
    if (!creds || !spacesLoaded) return;
    const productName = manifest?.space_name ?? product.product_name;
    const refresh = () => {
      listAllApprovals(product.space_id, productName, spaces, creds)
        .then((a) => setPendingApprovals(a.length))
        .catch(() => {});
    };
    refresh();
    // A new approval can open mid-conversation, or from a background/scheduled run entirely
    // outside this session — a light periodic re-check is what makes either visible without a
    // manual reload.
    const approvalPoll = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(approvalPoll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, spacesLoaded, spaces, product.space_id, product.product_name, manifest?.space_name]);

  // "New session" doesn't create anything — /new IS the new-session surface, and a session is
  // only minted on a real first message (lazy creation). Navigating there is the whole action.
  function handleNewSession() {
    router.push(`/p/${product.slug}/new`);
  }

  if (!isHydrated || !isAuthenticated) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  const hidden = new Set(manifest?.ui.hidden_core_items ?? []);
  const primaryNav: SidebarNavEntry[] = [
    ...DEFAULT_PRIMARY_NAV.filter((item) => !hidden.has(item.key)),
    ...(pendingApprovals > 0
      ? [{ key: "approvals", icon: "agents" as const, label: "Approvals", badge: pendingApprovals }]
      : []),
  ];
  const moreNav = DEFAULT_MORE_NAV.filter((item) => !hidden.has(item.key));
  const rawKey = pathname?.split("/").filter(Boolean)[2] ?? "new";
  // /new and /sessions are the conversation flow, which deliberately has no nav item of its own
  // (the "new session" button and the recent list below it are its entry points), so neither
  // should light up a nav entry.
  const activeKey = rawKey === "sessions" ? "new" : rawKey;
  const canUseWorkspace = true;
  const recentProjectThreads = projectThreads
    .filter((thread) => Boolean(thread.project_id) && !thread.parent_thread_id && thread.thread_kind !== "private")
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const currentEntry = activeSpaceId === product.space_id
    ? {
        id: product.space_id,
        name: manifest?.space_name ?? product.product_name,
        meta: "Space assistant",
      }
    : {
        id: activeSpaceId,
        name: spaces.find((s) => s.id === activeSpaceId)?.name ?? manifest?.space_name ?? "Space",
        meta: "Workspace",
      };

  return (
    <div id="app">
      <div
        className={["mobile-backdrop", mobileNavOpen ? "show" : ""].filter(Boolean).join(" ")}
        onClick={() => setMobileNavOpen(false)}
      />
      <Sidebar
        brandName={manifest?.space_name ?? product.product_name}
        iconOnly={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        mobileOpen={mobileNavOpen}
        activeKey={activeKey}
        onNavigate={(key) => router.push(`/p/${product.slug}/${key}`)}
        primaryNav={primaryNav}
        moreNav={moreNav}
        projects={projects.map((p) => ({ id: p.id, label: p.name }))}
        onOpenProject={(id) => router.push(`/p/${product.slug}/projects/${id}`)}
        onMoreProjects={() => router.push(`/p/${product.slug}/projects/all`)}
        {...(canUseWorkspace
          ? { onNewThread: handleNewSession, onNewProject: () => router.push(`/p/${product.slug}/projects/all`) }
          : {})}
        threads={sessions.map((s) => ({ id: s.id, label: s.title ?? "Untitled conversation" }))}
        onOpenThread={(id) => router.push(`/p/${product.slug}/sessions/${id}`)}
        onMoreThreads={() => router.push(`/p/${product.slug}/sessions`)}
        // Only claim there are more when the fetch actually came back full — otherwise an account
        // with three sessions is told some are hidden.
        hasMoreThreads={sessions.length >= SIDEBAR_RECENT_SESSIONS}
        projectThreads={recentProjectThreads.slice(0, SIDEBAR_RECENT_PROJECT_THREADS).map((thread) => ({
          id: thread.id,
          label: thread.title ?? "Untitled thread",
          ...(thread.project_id ? { projectId: thread.project_id } : {}),
        }))}
        onOpenProjectThread={(threadId) => router.push(`/p/${product.slug}/threads/${threadId}`)}
        onMoreProjectThreads={() => router.push(`/p/${product.slug}/threads`)}
        hasMoreProjectThreads={recentProjectThreads.length > SIDEBAR_RECENT_PROJECT_THREADS}
        spaceSwitcher={{
          current: currentEntry,
          entries: [
            { id: product.space_id, name: product.product_name, meta: "Space assistant" },
            ...spaces.map((space) => ({ id: space.id, name: space.name, meta: `${space.role} · ${space.space_status}` })),
          ],
          open: switcherOpen,
          onToggle: () => {
            if (sidebarCollapsed) {
              toggleSidebar();
              setSwitcherOpen(false);
            } else {
              setSwitcherOpen((v) => !v);
            }
          },
          onSwitch: (id) => {
            setSwitcherOpen(false);
            if (id === product.space_id) {
              setActiveSpace(product.space_id, product.product_name);
            } else {
              const space = spaces.find((item) => item.id === id);
              setActiveSpace(id, space?.name ?? null);
            }
            // Re-scoping happens via context — land on Home, now scoped to the switched space.
            // Space management is reached from the Spaces list.
            router.push(`/p/${product.slug}`);
          },
          onCreate: () => {
            setSwitcherOpen(false);
            router.push(`/p/${product.slug}/spaces`);
          },
          canCreate: true,
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
              background: "#fde68a",
              borderBottom: "1px solid #b45309",
              fontSize: 12.5,
              color: "#78350f",
            }}
          >
            <span style={{ color: "#78350f" }}>
              Verify your email address to confirm account ownership.
            </span>
            <button
              type="button"
              onClick={() => router.push(`/p/${product.slug}/verify-email`)}
              style={{
                background: "#78350f",
                border: "none",
                borderRadius: 6,
                color: "#fde68a",
                fontWeight: 600,
                fontSize: 12.5,
                padding: "4px 10px",
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
      {/* Cookie consent banner — only shown when product's cookiePolicy is "third_party" and
          the visitor hasn't accepted yet. ePrivacy Directive requires explicit consent before
          non-essential cookies can be set. */}
      {cookieConsentPending && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "var(--surface2, #1e1e2e)",
            color: "var(--text1, #fff)",
            borderTop: "1px solid var(--border)",
            padding: "12px 20px",
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            fontSize: 13,
          }}
        >
          <span style={{ flex: 1 }}>
            This product uses cookies to improve your experience. By continuing, you agree to our{" "}
            {manifest?.legal.privacy_policy_url
              ? <a href={manifest.legal.privacy_policy_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Privacy Policy</a>
              : "privacy policy"}
            {manifest?.legal.tos_url && (
              <> and{" "}<a href={manifest.legal.tos_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Terms of Service</a></>
            )}
            .
          </span>
          <button
            type="button"
            onClick={acceptCookies}
            style={{
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "6px 16px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 13,
              whiteSpace: "nowrap",
            }}
          >
            Accept
          </button>
        </div>
      )}
    </div>
  );
}
