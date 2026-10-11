"use client";


// Sidebar → More → Connectors: the app store for the active business.
//
// This page used to lead with a hand-written list of about a dozen connectors (X/Twitter through
// Meta Ads) with the real directory — several thousand apps across Composio and Pipedream — hidden
// behind a "Browse all apps" button. That inverted the truth: the small list is our RECOMMENDATION,
// the directory is what the platform can actually reach. So there is now one grid, ordered by what
// people genuinely use most (Composio's own `sort_by=usage`, not a ranking we invented), with the
// curated entries merged in and marked rather than given their own section.
//
// Both sources render through the same AppCard, with the provider's real logo when it sends one.

import * as React from "react";
import { Button, FormInput, useToast, Toast } from "@naelao/ui";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getConnectorStatus,
  getConnectorDirectory,
  connectorProvider,
  type ConnectorInfo,
  type DirectoryApp,
} from "@/lib/api";
import {
  startConnectorConnect,
  startDirectoryConnect,
  submitManualConnectorKey,
  consumeConnectorReturnMarker,
} from "@/lib/connectorActions";
import { AppCard, type AppCardModel } from "@/components/AppCard";
import { ConnectorAliases } from "@/components/ConnectorAliases";

type Tab = "popular" | "connected" | "az";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "popular", label: "Most used" },
  { key: "connected", label: "Connected" },
  { key: "az", label: "A–Z" },
];

const PAGE_SIZE = 60;

export default function ConnectorsPage() {
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const creds = React.useMemo(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null, [session?.session_token, session?.end_user_id]);

  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<Tab>("popular");
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [manualKeyFor, setManualKeyFor] = React.useState<ConnectorInfo | null>(null);
  const [manualKeyValue, setManualKeyValue] = React.useState("");

  const [directory, setDirectory] = React.useState<DirectoryApp[] | null>(null);
  const [directoryNote, setDirectoryNote] = React.useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = React.useState(false);
  const [directoryCursor, setDirectoryCursor] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      setConnectors(await getConnectorStatus(activeSpaceId, creds));
    } catch {
      show("Couldn't load your connected apps");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Land back here after any redirect-based connect flow (hosted Composio/Pipedream, or a bespoke
  // OAuth app) — every flow marks `${id}_connected=1` / `${id}_oauth_error=` on return.
  React.useEffect(() => {
    if (connectors.length === 0) return;
    let touched = false;
    for (const c of connectors) {
      const marker = consumeConnectorReturnMarker(c.id);
      if (!marker) continue;
      touched = true;
      show(marker.error ? `${c.name} connection failed: ${marker.error}` : `${c.name} connected.`);
    }
    if (touched) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors.length]);

  /** `append` continues from the last cursor; otherwise this starts a fresh page or search. */
  const loadDirectory = React.useCallback(
    async (append = false) => {
      if (!creds) return;
      setDirectoryLoading(true);
      try {
        const page = await getConnectorDirectory(activeSpaceId, creds, {
          q: query.trim() || undefined,
          limit: PAGE_SIZE,
          sort: tab === "az" ? "name" : "popular",
          ...(append && directoryCursor ? { cursor: directoryCursor } : {}),
        });
        // Anything we already ship a purpose-built connector for is represented by that connector's
        // own card, which carries real declared operations — listing it twice would offer a generic
        // brokered connection alongside the better one.
        const fresh = page.apps.filter((a) => !a.curated_as);
        setDirectory((prev) => {
          if (!append || !prev) return fresh;
          // Both providers can offer the same app, and a later page can repeat one the merge
          // already emitted — dedupe on arrival rather than rendering it twice.
          const seen = new Set(prev.map((a) => a.slug));
          return [...prev, ...fresh.filter((a) => !seen.has(a.slug))];
        });
        setDirectoryCursor(page.next_cursor ?? null);
        const off = page.providers.filter((p) => !p.available);
        setDirectoryNote(
          off.length === page.providers.length
            ? "The app directory isn't switched on for this platform yet."
            : off.length > 0
              ? `${off.map((p) => p.provider).join(" and ")} is unavailable right now, so this list is incomplete.`
              : null
        );
      } catch (err) {
        if (!append) setDirectory([]);
        setDirectoryNote(err instanceof Error ? err.message : "Couldn't load the app directory.");
      } finally {
        setDirectoryLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [activeSpaceId, session, query, tab, directoryCursor]
  );

  // Deliberately NOT a dependency on `loadDirectory` itself: that callback closes over
  // `directoryCursor`, so depending on it would re-fire this every time a page was appended and
  // restart from the beginning. The ref keeps the latest implementation without the identity churn.
  const loadDirectoryRef = React.useRef(loadDirectory);
  loadDirectoryRef.current = loadDirectory;

  // The grid is directory-backed from the first render — there is no "browse" step to opt into.
  // A search re-runs it server-side (thousands of apps; a client-side filter over one page would
  // report "no results" for anything not on it), debounced so typing doesn't fire per keystroke.
  React.useEffect(() => {
    if (tab === "connected") return;
    const q = query.trim();
    const timer = setTimeout(
      () => {
        setDirectoryCursor(null);
        void loadDirectoryRef.current(false);
      },
      q ? 300 : 0
    );
    return () => clearTimeout(timer);
  }, [query, tab, activeSpaceId]);

  async function handleConnect(model: AppCardModel) {
    if (!creds) return;
    const curated = connectors.find((c) => c.id === model.id);
    setBusyId(model.id);
    try {
      if (curated) {
        const { needsManualKey } = await startConnectorConnect(activeSpaceId, creds, curated, window.location.href);
        if (needsManualKey) {
          setManualKeyFor(curated);
          setManualKeyValue("");
          setBusyId(null);
        }
      } else {
        await startDirectoryConnect(activeSpaceId, creds, model.id, window.location.href);
      }
      // Hosted/OAuth flows: the browser is already navigating away, leave the button busy.
    } catch (err) {
      show(err instanceof Error ? err.message : `Failed to start connecting ${model.name}`);
      setBusyId(null);
    }
  }

  async function handleManualSubmit() {
    if (!creds || !manualKeyFor || !manualKeyValue.trim()) return;
    const id = manualKeyFor.id;
    setBusyId(id);
    try {
      await submitManualConnectorKey(activeSpaceId, creds, id, manualKeyValue.trim());
      setManualKeyFor(null);
      setManualKeyValue("");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setBusyId(null);
    }
  }

  const available = connectors.filter((c) => c.status === "available");
  const comingSoon = connectors.filter((c) => c.status === "coming_soon");

  const curatedCards: AppCardModel[] = React.useMemo(
    () =>
      available.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.summary,
        logo: c.logo,
        provider: connectorProvider(c),
        connected: Boolean(c.connected),
        recommended: true,
        personal: c.scope_model === "user",
      })),
    [available]
  );

  const directoryCards: AppCardModel[] = React.useMemo(
    () =>
      (directory ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description || a.categories.slice(0, 3).join(" · ") || "Connect it and your assistant can use it.",
        logo: a.logo,
        provider: a.provider,
        connected: false,
        recommended: false,
      })),
    [directory]
  );

  // A local filter over the curated cards only — the directory half is already filtered
  // server-side by the same query, so filtering it again here would do nothing but risk
  // disagreeing with what the server matched on.
  const q = query.trim().toLowerCase();
  const matchingCurated = q
    ? curatedCards.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    : curatedCards;

  const cards: AppCardModel[] =
    tab === "connected"
      ? curatedCards.filter((c) => c.connected)
      : // Recommended and already-connected apps lead; the ranked directory follows. Both halves
        // are then rendered as one continuous grid, so the boundary isn't a visible wall.
        [...matchingCurated.filter((c) => c.connected), ...matchingCurated.filter((c) => !c.connected), ...directoryCards];

  const connectedCount = curatedCards.filter((c) => c.connected).length;

  if (loading) return <div className="page-view">Loading…</div>;

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Apps</div>
        <div className="page-subtitle">
          Everything your assistant and project agents can reach. Most connect by signing in on the
          app&apos;s own page — there is no API key to hunt down.
        </div>
      </div>

      {creds && <ConnectorAliases spaceId={activeSpaceId} session={creds} connectors={connectors} onError={show} />}

      <div className="search-bar">
        <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
          <circle cx="7" cy="7" r="4.5" />
          <line x1="10.5" y1="10.5" x2="14" y2="14" />
        </svg>
        <input
          type="text"
          placeholder="Search thousands of apps — Gmail, Airtable, Shopify, Jira…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="marketplace-filters">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`filter-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "connected" && connectedCount > 0 ? ` · ${connectedCount}` : ""}
          </button>
        ))}
        {directoryLoading && (
          <span style={{ fontSize: 12, color: "var(--text3)" }}>Loading…</span>
        )}
      </div>

      {directoryNote && tab !== "connected" && (
        <p style={{ color: "var(--text3)", fontSize: 12.5, marginBottom: 12 }}>{directoryNote}</p>
      )}

      {manualKeyFor && (
        <div className="settings-block" style={{ marginBottom: 16 }}>
          <div className="settings-row" style={{ flexWrap: "wrap", gap: 8 }}>
            <div>
              <div className="settings-row-label">Connect {manualKeyFor.name}</div>
              <div className="settings-row-sub">This one needs a key from your own {manualKeyFor.name} account.</div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <FormInput
                type="password"
                placeholder={`${manualKeyFor.name} API key`}
                value={manualKeyValue}
                onChange={(e) => setManualKeyValue(e.target.value)}
                style={{ minWidth: 240 }}
              />
              <Button size="sm" onClick={handleManualSubmit} disabled={busyId === manualKeyFor.id || !manualKeyValue.trim()}>
                {busyId === manualKeyFor.id ? "Connecting…" : "Connect"}
              </Button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setManualKeyFor(null); setManualKeyValue(""); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {cards.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13, marginBottom: 24 }}>
          {tab === "connected"
            ? "Nothing connected yet. Pick an app from Most used to get started."
            : directoryLoading
              ? "Searching…"
              : `No apps match "${query.trim()}".`}
        </p>
      ) : (
        <div className="app-grid">
          {cards.map((c) => (
            <AppCard key={c.id} app={c} busy={busyId === c.id} onConnect={() => void handleConnect(c)} />
          ))}
        </div>
      )}

      {tab !== "connected" && directoryCursor && (
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <Button size="sm" onClick={() => void loadDirectory(true)} disabled={directoryLoading}>
            {directoryLoading ? "Loading…" : "Show more apps"}
          </Button>
        </div>
      )}

      {tab !== "connected" && comingSoon.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 28 }}>Not ready yet</div>
          <div className="app-grid">
            {comingSoon.map((c) => (
              <div key={c.id} className="app-card" style={{ cursor: "default", opacity: 0.55 }}>
                <div className="app-card-header">
                  <div className="app-card-initial">{c.name.slice(0, 1)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="app-card-name">{c.name}</div>
                    <div className="app-card-publisher">Coming soon</div>
                  </div>
                </div>
                <div className="app-card-desc">{c.summary}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <Toast toast={toast} />
    </div>
  );
}
