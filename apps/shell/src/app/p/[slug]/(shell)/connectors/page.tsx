"use client";

export const runtime = "edge";

// Sidebar → More → Connectors: a real click-to-install app browser for the active
// business/space, promoting the business-detail page's inline "Connect Apps" panel into its own
// searchable, filterable page. Composio is the default provider filter (it's what most of the
// catalogue is routed through); Pipedream is a real, smaller, opt-in filter (Notion today).
// Manual-key and bespoke-OAuth connectors (Whop) show up under "All".

import * as React from "react";
import { Button, FormInput, useToast, Toast } from "@naelao/ui";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getConnectorStatus, getConnectorDirectory, connectorProvider, type ConnectorInfo, type DirectoryApp } from "@/lib/api";
import { startConnectorConnect, startDirectoryConnect, submitManualConnectorKey, consumeConnectorReturnMarker } from "@/lib/connectorActions";

type ProviderFilter = "all" | "composio" | "pipedream";

export default function ConnectorsPage() {
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");
  // Composio is the DEFAULT filter per the ask — not "all" — since it's the common case; a user
  // who wants Pipedream's smaller list, or everything, switches explicitly.
  const [provider, setProvider] = React.useState<ProviderFilter>("composio");
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [manualKeyFor, setManualKeyFor] = React.useState<string | null>(null);
  const [manualKeyValue, setManualKeyValue] = React.useState("");
  // The full provider directory — everything reachable, as opposed to the curated recommendations
  // above it. Searched server-side (there are thousands), so this is its own request rather than
  // a filter over an already-loaded list.
  const [directory, setDirectory] = React.useState<DirectoryApp[] | null>(null);
  const [directoryNote, setDirectoryNote] = React.useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = React.useState(false);
  const [showDirectory, setShowDirectory] = React.useState(false);
  // The providers page 100 apps each at a time. Without carrying the cursor the page showed one
  // batch and stopped, which reads as "that's all there is" rather than "there are thousands".
  const [directoryCursor, setDirectoryCursor] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      setConnectors(await getConnectorStatus(activeSpaceId, creds));
    } catch {
      show("Couldn't load connectors");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Land back here after any redirect-based connect flow (Composio/Pipedream hosted, or a bespoke
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

  async function handleConnect(c: ConnectorInfo) {
    if (!creds) return;
    setBusyId(c.id);
    try {
      const { needsManualKey } = await startConnectorConnect(activeSpaceId, creds, c, window.location.href);
      if (needsManualKey) {
        setManualKeyFor(c.id);
        setManualKeyValue("");
        setBusyId(null);
      }
      // Composio/OAuth: the browser is already navigating away, nothing else to do here.
    } catch (err) {
      show(err instanceof Error ? err.message : `Failed to start connecting ${c.name}`);
      setBusyId(null);
    }
  }

  /** `append` continues from the last cursor; otherwise this starts a fresh search. */
  const loadDirectory = React.useCallback(
    async (append = false) => {
      if (!creds) return;
      setDirectoryLoading(true);
      try {
        const page = await getConnectorDirectory(activeSpaceId, creds, {
          q: query.trim() || undefined,
          limit: 100,
          ...(append && directoryCursor ? { cursor: directoryCursor } : {}),
        });
        // Anything we already ship a purpose-built connector for is listed above — showing it
        // twice would offer a generic brokered connection alongside the better one.
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
    [activeSpaceId, session, query, directoryCursor]
  );

  // Typing a name searches EVERYTHING, not just the dozen recommendations above.
  //
  // Before this, the search box filtered the curated list only, and the full directory sat behind
  // a separate "Browse all apps" button. So searching for an app we happen not to curate — most
  // of them — returned nothing, which reads as "this platform can't reach it" when in fact it is
  // one of several thousand the providers broker. A search that can only find what you already
  // know about is not a search.
  //
  // Deliberately NOT a dependency on `loadDirectory`: that callback closes over `directoryCursor`,
  // so depending on it would re-fire this effect every time a page was appended and restart the
  // search from scratch. The ref keeps the latest implementation without the identity churn.
  const loadDirectoryRef = React.useRef(loadDirectory);
  loadDirectoryRef.current = loadDirectory;
  React.useEffect(() => {
    if (query.trim().length < 2) return;
    const timer = setTimeout(() => {
      setShowDirectory(true);
      setDirectoryCursor(null);
      void loadDirectoryRef.current(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, activeSpaceId]);

  async function handleDirectoryConnect(app: DirectoryApp) {
    if (!creds) return;
    setBusyId(app.id);
    try {
      await startDirectoryConnect(activeSpaceId, creds, app.id, window.location.href);
      // The browser is navigating away; leave the button busy.
    } catch (err) {
      show(err instanceof Error ? err.message : `Failed to start connecting ${app.name}`);
      setBusyId(null);
    }
  }

  async function handleManualSubmit(connectorId: string) {
    if (!creds || !manualKeyValue.trim()) return;
    setBusyId(connectorId);
    try {
      await submitManualConnectorKey(activeSpaceId, creds, connectorId, manualKeyValue.trim());
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
  const filtered = available.filter((c) => {
    if (provider !== "all") {
      const p = connectorProvider(c);
      if (provider === "composio" && p !== "composio") return false;
      if (provider === "pipedream" && p !== "pipedream") return false;
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q);
    }
    return true;
  });

  if (loading) return <div className="page-view">Loading…</div>;

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Connectors</div>
        <div className="page-subtitle">
          Real third-party apps your assistant and project agents can reach over MCP — click Connect and sign in, no API keys to hunt down for most of these.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div className="search-bar" style={{ margin: 0, maxWidth: 260, flex: 1 }}>
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="14" y2="14" /></svg>
          <input type="text" placeholder="Search all apps…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ fontSize: 13 }} />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["composio", "pipedream", "all"] as ProviderFilter[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className="btn btn-sm"
              style={{
                border: `1px solid ${provider === p ? "var(--accent)" : "var(--border)"}`,
                background: provider === p ? "var(--accent-dim)" : "transparent",
                color: provider === p ? "var(--accent)" : "var(--text2)",
                textTransform: "capitalize",
              }}
            >
              {p === "all" ? "All providers" : p}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13, marginBottom: 24 }}>
          No connectors match {query.trim() ? `"${query}"` : "this filter"}.
        </p>
      ) : (
        <div className="settings-block" style={{ marginBottom: 24 }}>
          {filtered.map((c) => (
            <React.Fragment key={c.id}>
              <div className="settings-row">
                <div>
                  <div className="settings-row-label">
                    {c.name}
                    <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                      {connectorProvider(c)}
                    </span>
                    {c.scope_model === "user" && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text3)" }}>· personal</span>
                    )}
                  </div>
                  <div className="settings-row-sub">{c.summary}</div>
                </div>
                {c.connected ? (
                  <span className="badge badge-green"><span className="badge-dot" />Connected</span>
                ) : manualKeyFor !== c.id ? (
                  <Button size="sm" onClick={() => handleConnect(c)} disabled={busyId === c.id}>
                    {busyId === c.id ? "Connecting…" : "Connect"}
                  </Button>
                ) : null}
              </div>
              {manualKeyFor === c.id && (
                <div style={{ padding: "0 16px 14px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <FormInput
                    type="password"
                    placeholder={`${c.name} API key`}
                    value={manualKeyValue}
                    onChange={(e) => setManualKeyValue(e.target.value)}
                    style={{ flex: 1, minWidth: 220 }}
                  />
                  <Button size="sm" onClick={() => handleManualSubmit(c.id)} disabled={busyId === c.id || !manualKeyValue.trim()}>
                    {busyId === c.id ? "Connecting…" : "Connect"}
                  </Button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setManualKeyFor(null); setManualKeyValue(""); }} disabled={busyId === c.id}>
                    Cancel
                  </button>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}


      <div className="section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span>Everything else</span>
        {!showDirectory && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => { setShowDirectory(true); void loadDirectory(false); }}
          >
            Browse all apps
          </button>
        )}
      </div>
      <p style={{ color: "var(--text3)", fontSize: 13, marginBottom: 12 }}>
        The list above is what we recommend. Thousands more are reachable through the same
        one-click sign-in — searching by name is far quicker than scrolling.
      </p>

      {showDirectory && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <Button
              size="sm"
              onClick={() => {
                setDirectoryCursor(null);
                void loadDirectory(false);
              }}
              disabled={directoryLoading}
            >
              {directoryLoading ? "Searching…" : query.trim() ? `Search "${query.trim()}"` : "Refresh"}
            </Button>
            {directory && (
              <span style={{ fontSize: 12, color: "var(--text3)", alignSelf: "center" }}>
                {directory.length} shown{directoryCursor ? " — more available" : ""}
              </span>
            )}
          </div>

          {directoryNote && (
            <p style={{ color: "var(--text3)", fontSize: 12, marginBottom: 12 }}>{directoryNote}</p>
          )}

          {directoryLoading && directory === null ? (
            <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading the app directory…</p>
          ) : directory && directory.length === 0 ? (
            <p style={{ color: "var(--text3)", fontSize: 13 }}>
              {query.trim() ? `No apps match "${query.trim()}".` : "No apps available."}
            </p>
          ) : directory ? (
            <div className="settings-block">
              {directory.map((a) => (
                <div className="settings-row" key={a.id}>
                  <div>
                    <div className="settings-row-label">
                      {a.name}
                      <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                        {a.provider}
                      </span>
                    </div>
                    <div className="settings-row-sub">
                      {a.description || a.categories.slice(0, 3).join(" · ") || a.slug}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => void handleDirectoryConnect(a)} disabled={busyId === a.id}>
                    {busyId === a.id ? "Connecting…" : "Connect"}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {directory && directoryCursor && (
            <div style={{ marginTop: 12, textAlign: "center" }}>
              <Button size="sm" onClick={() => void loadDirectory(true)} disabled={directoryLoading}>
                {directoryLoading ? "Loading…" : "Load more apps"}
              </Button>
            </div>
          )}
        </div>
      )}

      {comingSoon.length > 0 && (
        <>
          <div className="section-label">Coming soon</div>
          <div className="grid-3">
            {comingSoon.map((c) => (
              <div key={c.id} className="card" style={{ cursor: "default", opacity: 0.6 }}>
                <div className="card-title">{c.name}</div>
                <div className="card-desc">{c.summary}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <Toast toast={toast} />
    </div>
  );
}
